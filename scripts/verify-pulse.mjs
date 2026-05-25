// US-020 browser-verification harness: boot the REAL gateway (serving the built
// UI) on a spare port, then seed the `event` table with activity spread across
// the last hour — meaningful events (bars), result rows with rising cost/tokens
// (the overlay line), and a couple of api_retry rows (the red rail) — so the
// Pulse chart has real time-series data to render. Leaves the gateway running
// for automate-browser. Uses a spare port so the live :3747 is untouched.
//
// Run: tsx scripts/verify-pulse.mjs   (Ctrl-C to stop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-pulse-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "verify-token";
const PORT = 3768;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boot the gateway (opens + caches the DB handle).
await import("../src/gateway/index.ts");
await sleep(400);

// Seed straight into the same cached DB handle the gateway uses.
const { getDb } = await import("../src/db/index.ts");
const db = getDb();

const now = Date.now();
const sessions = [
  { id: "sess-opus", model: "claude-opus-4-7", status: "running", color: "#6366f1" },
  { id: "sess-sonnet", model: "claude-sonnet-4-6", status: "idle", color: "#10b981" },
];
const upSession = db.prepare(
  `INSERT INTO session (id, model, status, color, created_at, last_activity, total_cost_usd)
     VALUES (@id, @model, @status, @color, @created_at, @last_activity, 0)
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, model=excluded.model`,
);
for (const s of sessions)
  upSession.run({ ...s, created_at: now - 3_600_000, last_activity: now });

const insEvent = db.prepare(
  `INSERT INTO event (session_id, hook_event_name, stream_type, tool_name, payload, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
);

// Spread ~22 minutes of activity across the last hour: a burst of tool events
// every ~3 minutes, two api_retry blips, and rising cost/token result rows.
let cumCost = 0;
for (let m = 58; m >= 1; m -= 3) {
  const ts = now - m * 60_000;
  // A handful of meaningful hook events in this slice.
  const burst = 3 + ((m * 7) % 9);
  for (let k = 0; k < burst; k++) {
    insEvent.run("sess-opus", k % 2 ? "PostToolUse" : "PreToolUse", "hook", "Bash", "{}", ts + k * 1000);
  }
  // Stream deltas should NOT inflate the bar count — seed some to prove it.
  insEvent.run("sess-opus", null, "stream_event:content_block_delta", null, "{}", ts + 500);
  insEvent.run("sess-opus", null, "stream_event:content_block_delta", null, "{}", ts + 600);

  // A result row: per-turn tokens + cumulative cost climbing over time.
  cumCost += 0.04 + (m % 5) * 0.01;
  const outTokens = 400 + ((58 - m) * 90);
  insEvent.run(
    "sess-opus",
    null,
    "result",
    null,
    JSON.stringify({ type: "result", total_cost_usd: cumCost, usage: { output_tokens: outTokens } }),
    ts + 2000,
  );
}
// Two api_retry blips on the rail.
insEvent.run("sess-opus", null, "system/api_retry", null, "{}", now - 40 * 60_000);
insEvent.run("sess-sonnet", null, "system/api_retry", null, "{}", now - 12 * 60_000);

await sleep(200);
const pulse = await (await fetch(`${BASE}/api/claude/pulse?minutes=60`)).json();
console.log(
  `\n[verify] pulse(60m): ${pulse.buckets.length} buckets, ${pulse.bucketMs / 1000}s each\n` +
    `  totals: events=${pulse.totals.events} retries=${pulse.totals.retries} ` +
    `tokens=${pulse.totals.tokens} cost=$${pulse.totals.cost.toFixed(2)}`,
);
console.log(`\n[verify] gateway live on ${BASE} (token=${TOKEN}). Ctrl-C to stop.`);

process.on("SIGINT", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
