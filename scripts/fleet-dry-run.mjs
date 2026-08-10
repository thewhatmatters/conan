#!/usr/bin/env node
// WHA-125 AC 6: run the lineage dry-run and print what landed.
//
//   npm run fleet:dry-run
//
// Writes to a THROWAWAY database by default. Lineage rows for a ticket nobody
// dispatched would be indistinguishable from real ones in the dev ledger, so
// the safe default is a fresh temp dir; set CONAN_DATA_DIR yourself if you
// deliberately want to inspect the result somewhere that survives.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.CONAN_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-fleet-dryrun-"));
  process.env.CONAN_DATA_DIR = dir;
  process.env.CONAN_DB_PATH = path.join(dir, "conan.db");
}

const { runLineageDryRun } = await import("../src/fleet/dryrun.ts");
const { getDb, closeDb } = await import("../src/db/index.ts");

const result = await runLineageDryRun({ linearKey: "WHA-125-DRYRUN" });

console.log(`database: ${process.env.CONAN_DB_PATH}\n`);
console.log("── journey ─────────────────────────────────────────────────────");
for (const line of result.log) console.log(`  ${line}`);

console.log("\n── rows written ────────────────────────────────────────────────");
const tables = [
  "fleet_principal",
  "fleet_binding",
  "fleet_ticket",
  "fleet_run",
  "fleet_task",
  "fleet_role_assignment",
  "attempt",
  "attempt_session",
  "fleet_artifact",
  "fleet_evidence",
  "fleet_evidence_command",
  "fleet_critique",
  "fleet_decision",
];
const db = getDb();
for (const t of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
  console.log(`  ${t.padEnd(24)} ${n}`);
}

console.log("\n── verdict trail ───────────────────────────────────────────────");
for (const c of db
  .prepare(
    "SELECT round, verdict, evidence_id, critic_attempt_id FROM fleet_critique ORDER BY round",
  )
  .all()) {
  console.log(
    `  round ${c.round}: ${c.verdict.padEnd(15)} evidence=${c.evidence_id ?? "-"} critic_attempt=${c.critic_attempt_id}`,
  );
}
for (const d of db
  .prepare(
    "SELECT gate, state, decision, reason_code FROM fleet_decision ORDER BY created_at",
  )
  .all()) {
  console.log(
    `  gate ${d.gate}: ${d.state}/${d.decision ?? "-"}${d.reason_code ? ` (${d.reason_code})` : ""}`,
  );
}

console.log("\n── refusals (hook arguments; verdicts are WHA-126's) ────────────");
for (const r of result.refusals) {
  console.log(
    `  ${r.leg}: code=${r.refusal.code} containment=${r.request.containment} ` +
      `floor=[${r.request.floor.join("|")}] candidate=${r.request.candidate.principalId} ` +
      `builder=${r.request.builder?.principalId ?? "none"} attempt_row_written=${r.spawned}`,
  );
}

closeDb();
console.log("\nOK — the whole journey exists as data.");
