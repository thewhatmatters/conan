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

const seed = new Database(dbPath);
seed.exec(PRE_WHA136_ATTEMPT);
seed
  .prepare(
    "INSERT INTO attempt (id, context, provider, containment_observed, started_at) VALUES (?,?,?,?,?)",
  )
  .run("a1", "chat", "claude", "none", 1);
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
