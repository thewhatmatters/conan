// US-023 test: cost ceiling + budget guard. Boots the real gateway against an
// isolated DB + settings file (and a fake `claude` so a throttled launch never
// reaches the network). Seeds session rows with known total_cost_usd directly
// into the DB, then drives the budget routes:
//   - PUT /api/claude/settings/budget is token-gated and persists ceilings
//   - GET /api/claude/budget computes costToday, dailyOver, per-session overage
//   - POST /api/claude/sessions is throttled (429) while over the daily ceiling
//
// Run: tsx scripts/test-budget.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-budget-test-"));
const dataDir = path.join(tmp, "data");
const settingsPath = path.join(tmp, "settings.json");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

// Minimal fake claude so a (non-throttled) launch doesn't hit the network.
const stub = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
const init = { type: "system", subtype: "init", session_id: "launched-" + Date.now(), model: "sonnet", tools: [], cwd: process.cwd() };
process.stdout.write(JSON.stringify(init) + "\\n");
setTimeout(() => process.exit(0), 4000);
`,
);
fs.chmodSync(stub, 0o755);

process.env.CONAN_CLAUDE_BIN = stub;
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_SETTINGS_PATH = settingsPath;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = (method, pathname, body, token) =>
  fetch(BASE + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-conan-token": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Seed a session row with a known cost + recent activity (counts toward today).
function seedSession(id, cost) {
  const db = new Database(path.join(dataDir, "conan.db"));
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO session (id, model, status, created_at, last_activity, total_cost_usd)
         VALUES (?, 'sonnet', 'idle', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET total_cost_usd = excluded.total_cost_usd,
                                     last_activity = excluded.last_activity`,
    ).run(id, now, now, cost);
  } finally {
    db.close();
  }
}

try {
  await import("../src/gateway/index.ts");
  await sleep(300);

  // The gateway opened the DB at boot (WAL), so a second connection can seed it.
  seedSession("sess-a", 8.0);
  seedSession("sess-b", 4.5); // costToday = 12.50

  // --- settings route is token-gated ------------------------------------
  check(
    "settings PUT rejects missing token (401)",
    (await req("PUT", "/api/claude/settings/budget", { daily_cost_ceiling_usd: 10 }, null)).status === 401,
  );

  // --- under budget: ceiling above spend --------------------------------
  await req("PUT", "/api/claude/settings/budget", {
    daily_cost_ceiling_usd: 25,
    per_session_cost_ceiling_usd: null,
    throttle_over_budget: false,
  }, TOKEN);
  let status = await (await req("GET", "/api/claude/budget")).json();
  check("costToday aggregates session cost", Math.abs(status.costToday - 12.5) < 1e-6);
  check("daily ceiling persisted", status.settings.dailyCostCeilingUsd === 25);
  check("under daily ceiling -> not over", status.dailyOver === false && status.overBudget === false);
  check("dailyPct computed", Math.abs(status.dailyPct - 50) < 1e-6);

  // --- per-session ceiling crossing -------------------------------------
  await req("PUT", "/api/claude/settings/budget", { per_session_cost_ceiling_usd: 5 }, TOKEN);
  status = await (await req("GET", "/api/claude/budget")).json();
  check("per-session overage detects sess-a (>= $5)", status.perSessionOver.some((s) => s.id === "sess-a"));
  check("per-session overage excludes sess-b (< $5)", !status.perSessionOver.some((s) => s.id === "sess-b"));
  check("per-session crossing flips overBudget", status.overBudget === true);

  // --- daily ceiling crossing + throttle --------------------------------
  await req("PUT", "/api/claude/settings/budget", {
    daily_cost_ceiling_usd: 10,
    per_session_cost_ceiling_usd: null,
    throttle_over_budget: true,
  }, TOKEN);
  status = await (await req("GET", "/api/claude/budget")).json();
  check("over daily ceiling -> dailyOver", status.dailyOver === true && status.overBudget === true);

  const throttled = await req("POST", "/api/claude/sessions", { cwd: tmp }, TOKEN);
  const throttledBody = await throttled.json();
  check("launch throttled with 429 when over budget", throttled.status === 429);
  check("throttle response carries a reason", typeof throttledBody.reason === "string" && throttledBody.reason.length > 0);

  // --- throttle off: launch allowed even over budget --------------------
  await req("PUT", "/api/claude/settings/budget", { throttle_over_budget: false }, TOKEN);
  const allowed = await req("POST", "/api/claude/sessions", { cwd: tmp }, TOKEN);
  check("launch allowed (200) when throttle disabled", allowed.status === 200);

  // --- raising the ceiling clears the over-budget state -----------------
  await req("PUT", "/api/claude/settings/budget", { daily_cost_ceiling_usd: 100 }, TOKEN);
  status = await (await req("GET", "/api/claude/budget")).json();
  check("raising the ceiling clears overBudget", status.overBudget === false);

  // --- settings persisted to disk ---------------------------------------
  const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  check("ceilings persisted to settings.json", onDisk.budget.dailyCostCeilingUsd === 100);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
