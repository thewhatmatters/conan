// US-023 browser-verification harness: boot the REAL gateway (serving the built
// UI) on a spare port, seed sessions with known cost, and configure a daily +
// per-session cost ceiling that the seeded spend exceeds — so the BudgetPanel
// renders its over-budget alert (and a per-session overage). Leaves the gateway
// running for automate-browser. Spare port so the live :3747 is untouched.
//
// Run: tsx scripts/verify-budget.mjs   (Ctrl-C to stop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-budget-"));
const dataDir = path.join(tmp, "data");
const settingsPath = path.join(tmp, "settings.json");
const TOKEN = "verify-token";
const PORT = 3770;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_SETTINGS_PATH = settingsPath;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

// Configure ceilings up front: $10 daily (seeded spend = $12.30, so over),
// $5 per-session (sess-opus at $7.80 trips it), throttle on.
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(
  settingsPath,
  JSON.stringify(
    {
      budget: {
        dailyCostCeilingUsd: 10,
        perSessionCostCeilingUsd: 5,
        throttleOverBudget: true,
      },
    },
    null,
    2,
  ),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await import("../src/gateway/index.ts");
await sleep(400);

const { getDb } = await import("../src/db/index.ts");
const db = getDb();

const now = Date.now();
const sessions = [
  { id: "sess-opus", model: "claude-opus-4-7", status: "running", color: "#6366f1", cost: 7.8 },
  { id: "sess-sonnet", model: "claude-sonnet-4-6", status: "idle", color: "#10b981", cost: 4.5 },
];
const up = db.prepare(
  `INSERT INTO session (id, model, status, color, created_at, last_activity, total_cost_usd)
     VALUES (@id, @model, @status, @color, @created_at, @last_activity, @cost)
   ON CONFLICT(id) DO UPDATE SET total_cost_usd=excluded.total_cost_usd`,
);
for (const s of sessions)
  up.run({ ...s, created_at: now - 3_600_000, last_activity: now });

console.log(`\n[verify-budget] gateway up on http://127.0.0.1:${PORT}`);
console.log("[verify-budget] seeded $12.30 spend vs $10 daily ceiling + $5 per-session");
console.log("[verify-budget] open the dashboard, then Ctrl-C to stop.\n");

process.on("SIGINT", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
