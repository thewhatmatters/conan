import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "../paths.js";

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
);

let db: Database.Database | null = null;

/**
 * Open (once) the dashboard SQLite database with WAL mode enabled and the
 * schema applied. Idempotent — safe to call on every startup.
 */
export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const handle = new Database(DB_PATH);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  handle.exec(schema);
  migrate(handle);

  db = handle;
  return db;
}

/**
 * Idempotently add columns introduced after US-001 to an existing database.
 * `CREATE TABLE IF NOT EXISTS` won't alter a pre-existing table, so we add any
 * missing columns by name. New columns must be nullable / have defaults.
 */
function migrate(handle: Database.Database): void {
  const sessionCols = new Set(
    handle
      .prepare("PRAGMA table_info(session)")
      .all()
      .map((c) => (c as { name: string }).name),
  );
  const added: Array<[string, string]> = [
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cache_read_input_tokens", "INTEGER"],
    ["cache_creation_input_tokens", "INTEGER"],
    ["context_tokens", "INTEGER"],
    ["worktree_path", "TEXT"],
    ["worktree_base_ref", "TEXT"],
    ["json_schema", "TEXT"],
    ["structured_result", "TEXT"],
    ["schema_valid", "INTEGER"],
    ["claude_version", "TEXT"],
    ["claude_pid", "INTEGER"],
  ];
  for (const [name, type] of added) {
    if (!sessionCols.has(name)) {
      handle.exec(`ALTER TABLE session ADD COLUMN ${name} ${type}`);
    }
  }

  // PD-1: last_message preview on chat_thread (added after US-013's schema).
  // Guard on the table existing so a fresh DB (schema.sql already has the
  // column) and a pre-PD-1 DB both migrate cleanly.
  const hasChatThread = handle
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_thread'",
    )
    .get();
  if (hasChatThread) {
    const cols = new Set(
      handle
        .prepare("PRAGMA table_info(chat_thread)")
        .all()
        .map((c) => (c as { name: string }).name),
    );
    if (!cols.has("last_message")) {
      handle.exec("ALTER TABLE chat_thread ADD COLUMN last_message TEXT");
    }
    // T3-1 US-006: which agent CLI drives the thread (claude|codex|grok).
    // Nullable — pre-multi-provider rows read as 'claude' at the select layer.
    if (!cols.has("provider")) {
      handle.exec("ALTER TABLE chat_thread ADD COLUMN provider TEXT");
    }
    if (!cols.has("effort")) {
      handle.exec("ALTER TABLE chat_thread ADD COLUMN effort TEXT");
    }
  }

  // (A prior migration nulled codex/grok thread models here — it was a fix for
  // persisting the REPORTED model, e.g. grok's `grok-4.5-build`. Now the LAUNCH
  // model is persisted instead (always a valid `-m` id), so that scrub is gone:
  // re-running it would wipe legitimately-saved codex/grok launch models.)

  // loop/conan-thread-toolbar US-004: per-project custom toolbar actions.
  // Kept here as well as schema.sql so existing databases pick up the table
  // even though CREATE TABLE IF NOT EXISTS is otherwise only additive for
  // fresh schemas.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS project_action (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      command    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_action_project
      ON project_action (project_id, created_at);
  `);

  // WHA-129: the fleet lineage `attempt` table. Same reason as project_action —
  // repeated here so an existing database picks it up, since schema.sql's
  // CREATE TABLE IF NOT EXISTS only ever helps a fresh one.
  handle.exec(`
    CREATE TABLE IF NOT EXISTS attempt (
      id                   TEXT PRIMARY KEY,
      context              TEXT NOT NULL,
      session_id           TEXT,
      provider             TEXT NOT NULL,
      model                TEXT,
      permission_mode      TEXT,
      containment_observed TEXT NOT NULL,
      cwd                  TEXT,
      project_id           TEXT REFERENCES project(id) ON DELETE SET NULL,
      started_at           INTEGER NOT NULL,
      ended_at             INTEGER,
      cost_usd             REAL,
      duration_ms          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attempt_session ON attempt (session_id);
    CREATE INDEX IF NOT EXISTS idx_attempt_started ON attempt (started_at);
  `);

  // WHA-136: project_id landed after the attempt table shipped, so an existing
  // database needs the column added by name — CREATE TABLE IF NOT EXISTS above
  // only helps a fresh one. SQLite permits a REFERENCES clause on ADD COLUMN
  // because the default is NULL.
  const attemptCols = new Set(
    handle
      .prepare("PRAGMA table_info(attempt)")
      .all()
      .map((c) => (c as { name: string }).name),
  );
  if (!attemptCols.has("project_id")) {
    handle.exec(
      "ALTER TABLE attempt ADD COLUMN project_id TEXT REFERENCES project(id) ON DELETE SET NULL",
    );
  }
  handle.exec(
    "CREATE INDEX IF NOT EXISTS idx_attempt_project ON attempt (project_id, started_at)",
  );
}

/** Close the database handle (used on shutdown / in tests). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
