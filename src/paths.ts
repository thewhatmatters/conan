import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repo root (one level up from src/). */
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Where local runtime data (the SQLite db) lives.
 * Defaults to ./.data in the repo; override with CONAN_DATA_DIR.
 * Kept out of ~/.conan so the dashboard's dev data never collides with
 * the Conan runtime directory.
 */
export const DATA_DIR =
  process.env.CONAN_DATA_DIR ?? path.join(PACKAGE_ROOT, ".data");

/** Absolute path to the dashboard SQLite database. */
export const DB_PATH =
  process.env.CONAN_DB_PATH ?? path.join(DATA_DIR, "conan.db");

/** Built UI assets served by the gateway in production. */
export const UI_DIST = path.join(PACKAGE_ROOT, "ui", "dist");

/** Home directory — used later to read Claude Code session JSONL under ~/.claude. */
export const HOME = homedir();
