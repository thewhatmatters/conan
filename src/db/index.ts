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
  ];
  for (const [name, type] of added) {
    if (!sessionCols.has(name)) {
      handle.exec(`ALTER TABLE session ADD COLUMN ${name} ${type}`);
    }
  }
}

/** Close the database handle (used on shutdown / in tests). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
