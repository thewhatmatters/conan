// US-030 browser-verification harness: boot the REAL gateway (serving the built
// UI) on a spare port, seed usage + a rate-limit api_retry with a reset time, so
// the Usage hero widget renders a real rate-limited state + resets-in countdown.
// Leaves the gateway running for automate-browser. Spare port; :3747 untouched.
//
// Run: tsx scripts/verify-usage.mjs   (Ctrl-C to stop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-usage-"));
const dataDir = path.join(tmp, "data");
const settingsPath = path.join(tmp, "settings.json");
const TOKEN = "verify-token";
const PORT = 3772;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_SETTINGS_PATH = settingsPath;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import("../src/gateway/index.ts");
await sleep(400);

const { getDb } = await import("../src/db/index.ts");
const db = getDb();
const now = Date.now();

// A configured daily ceiling so the widget shows a percent; cost ~ $4.20.
const { updateBudgetSettings } = await import("../src/settings/index.ts");
updateBudgetSettings({ dailyCostCeilingUsd: 10 });

const upSession = db.prepare(
  `INSERT INTO session (id, model, status, created_at, last_activity, total_cost_usd)
     VALUES (?, ?, 'running', ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET total_cost_usd = excluded.total_cost_usd,
                                 last_activity = excluded.last_activity`,
);
upSession.run("sess-opus", "claude-opus-4-7", now - 3_600_000, now, 3.1);
upSession.run("sess-sonnet", "claude-sonnet-4-6", now - 3_600_000, now, 1.1);

const insEvent = db.prepare(
  `INSERT INTO event (session_id, hook_event_name, stream_type, tool_name, payload, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
);
// Result rows for tokensToday.
insEvent.run("sess-opus", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 18400 } }), now - 90_000);
insEvent.run("sess-sonnet", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 6200 } }), now - 80_000);

// A rate-limit api_retry that resets ~14 minutes out — sets the limited badge
// and the live countdown. retry_after is in seconds from the event ts.
insEvent.run(
  "sess-opus",
  null,
  "system/api_retry",
  null,
  JSON.stringify({
    type: "system",
    subtype: "api_retry",
    error: { type: "rate_limit_error", message: "usage limit reached" },
    retry_after: 14 * 60,
  }),
  now - 5_000,
);

await sleep(200);
const usage = await (await fetch(`${BASE}/api/claude/usage`)).json();
console.log(
  `\n[verify] usage: cost=$${usage.costToday.toFixed(2)} tokens=${usage.tokensToday} ` +
    `pct=${usage.pct?.toFixed(0)}% rateLimited=${usage.rateLimited} ` +
    `resetsIn=${usage.resetAt ? Math.round((usage.resetAt - Date.now()) / 1000) + "s" : "—"}`,
);
console.log(`\n[verify] gateway live on ${BASE} (token=${TOKEN}). Ctrl-C to stop.`);

process.on("SIGINT", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
