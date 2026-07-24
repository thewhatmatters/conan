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

  // T3-1 fix: threads on providers without a model picker persisted the model
  // the driver REPORTED, which for grok is an internal build name
  // (`grok-4.5-build`) that `-m` rejects — so every turn in a reopened thread
  // exited 1. New writes are guarded by capabilities.modelSelection; this
  // clears already-saved values so existing threads recover. Idempotent.
  if (hasChatThread) {
    const cols = new Set(
      handle
        .prepare("PRAGMA table_info(chat_thread)")
        .all()
        .map((c) => (c as { name: string }).name),
    );
    if (cols.has("provider")) {
      handle.exec(
        "UPDATE chat_thread SET model = NULL WHERE provider IS NOT NULL AND provider <> 'claude' AND model IS NOT NULL",
      );
    }
  }

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
}

/** Close the database handle (used on shutdown / in tests). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
