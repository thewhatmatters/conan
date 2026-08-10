// The upgrade path. `getDb()` runs `schema.sql` as one `exec` and THEN
// `migrate()`, so anything in schema.sql that touches a column added after a
// table shipped fails against a database already on disk — before the ALTER
// that would have added it can run. WHA-136 put
// `CREATE INDEX … ON attempt (project_id, …)` in schema.sql, which made every
// pre-WHA-136 database throw `no such column: project_id` at boot. The gateway
// dies at import; there is no degraded mode.
//
// Runs against a throwaway SQLite file seeded with the OLD attempt table — env
// is pointed at a temp dir BEFORE the db module, which captures paths at
// import. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-db-test-"));
const dbPath = path.join(dataDir, "conan.db");
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = dbPath;

/** The `attempt` table exactly as WHA-129 shipped it — no `project_id`. */
const PRE_WHA136_ATTEMPT = `
  CREATE TABLE attempt (
    id                   TEXT PRIMARY KEY,
    context              TEXT NOT NULL,
    session_id           TEXT,
    provider             TEXT NOT NULL,
    model                TEXT,
    permission_mode      TEXT,
    containment_observed TEXT NOT NULL,
    cwd                  TEXT,
    started_at           INTEGER NOT NULL,
    ended_at             INTEGER,
    cost_usd             REAL,
    duration_ms          INTEGER
  );
`;

/** The chat tables as they stand today. WHA-125's AC 7 is about THESE rows:
 *  the lineage migration must not cost an existing install its chat threads. */
const EXISTING_CHAT_TABLES = `
  CREATE TABLE project (
    id         TEXT PRIMARY KEY,
    path       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chat_thread (
    session_id    TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    cwd           TEXT NOT NULL,
    model         TEXT,
    title         TEXT,
    created_at    INTEGER NOT NULL,
    last_activity INTEGER NOT NULL
  );
`;

const seed = new Database(dbPath);
seed.exec(PRE_WHA136_ATTEMPT);
seed.exec(EXISTING_CHAT_TABLES);
seed
  .prepare(
    "INSERT INTO attempt (id, context, provider, containment_observed, started_at) VALUES (?,?,?,?,?)",
  )
  .run("a1", "chat", "claude", "none", 1);
seed
  .prepare("INSERT INTO project (id, path, name, created_at) VALUES (?,?,?,?)")
  .run("p1", "/tmp/legacy-project", "legacy", 1);
seed
  .prepare(
    `INSERT INTO chat_thread (session_id, project_id, cwd, model, title, created_at, last_activity)
     VALUES (?,?,?,?,?,?,?)`,
  )
  .run("s1", "p1", "/tmp/legacy-project", "opus", "a thread from before", 1, 2);
seed.close();

const { getDb, closeDb } = await import("./index.js");

test("opens a database whose attempt table predates project_id (WHA-148)", () => {
  // The bug was a throw right here, not a wrong value.
  const db = getDb();

  const cols = new Set(
    (db.prepare("PRAGMA table_info(attempt)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  assert.ok(cols.has("project_id"), "migrate() should have added project_id");

  const indexes = new Set(
    (db.prepare("PRAGMA index_list(attempt)").all() as Array<{ name: string }>).map(
      (i) => i.name,
    ),
  );
  assert.ok(
    indexes.has("idx_attempt_project"),
    "the project index still has to exist — it just belongs after the ALTER",
  );

  // The upgrade is non-destructive: the row that was already there survives.
  const row = db.prepare("SELECT id, project_id FROM attempt").get() as {
    id: string;
    project_id: string | null;
  };
  assert.equal(row.id, "a1");
  assert.equal(row.project_id, null);

  closeDb();
});

test("WHA-125 AC 7: the lineage migration is additive — no chat data is lost", () => {
  // Re-opening after closeDb() re-runs schema.sql AND migrate() against the
  // same file, so this also proves the whole boot is idempotent.
  const db = getDb();

  // 1. What was already on disk is untouched, values and all.
  const thread = db
    .prepare("SELECT * FROM chat_thread WHERE session_id = ?")
    .get("s1") as Record<string, unknown>;
  assert.equal(thread.project_id, "p1");
  assert.equal(thread.title, "a thread from before");
  assert.equal(thread.model, "opus");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM chat_thread").get()!["n" as never],
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM project").get()!["n" as never],
    1,
  );
  const attempt = db
    .prepare("SELECT * FROM attempt WHERE id = ?")
    .get("a1") as Record<string, unknown>;
  assert.equal(attempt.context, "chat");
  assert.equal(attempt.provider, "claude");

  // 2. The six new attempt columns exist and read as null for the old row —
  // "no lineage" is the truth about an attempt recorded before lineage existed.
  const cols = new Set(
    (db.prepare("PRAGMA table_info(attempt)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const col of [
    "run_id",
    "ticket_id",
    "task_id",
    "role",
    "principal_id",
    "binding_id",
  ]) {
    assert.ok(cols.has(col), `migrate() never added attempt.${col}`);
    assert.equal(attempt[col], null);
  }

  // 3. Their indexes were created AFTER the ALTERs, never in schema.sql — the
  // WHA-148 trap. If this file's ordering ever regresses, getDb() throws above
  // and this assertion is never reached.
  const indexes = new Set(
    (db.prepare("PRAGMA index_list(attempt)").all() as Array<{ name: string }>).map(
      (i) => i.name,
    ),
  );
  assert.ok(indexes.has("idx_attempt_task"));
  assert.ok(indexes.has("idx_attempt_ticket"));

  // 4. The new tables reached an EXISTING database, not just a fresh one.
  const tables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name),
  );
  for (const t of [
    "fleet_principal",
    "fleet_binding",
    "fleet_ticket",
    "fleet_run",
    "fleet_task",
    "fleet_role_assignment",
    "attempt_session",
    "fleet_artifact",
    "fleet_evidence",
    "fleet_evidence_command",
    "fleet_critique",
    "fleet_decision",
  ]) {
    assert.ok(tables.has(t), `${t} is missing on an upgraded database`);
  }

  closeDb();
});
