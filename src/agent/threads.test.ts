// T3-1 US-006: the per-thread provider column. Covers the idempotent
// migration (a pre-multi-provider DB gains `provider` + `last_message`),
// null-coalescing to 'claude' on every read path, provider stickiness on
// conflicting upserts, and re-keying via adoptChatThread. Runs against a
// throwaway SQLite file — env is pointed at a temp dir BEFORE the db module
// (which captures paths at import) is loaded. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-threads-test-"));
const dbPath = path.join(dataDir, "conan.db");
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = dbPath;

// Pre-create a PRE-multi-provider database: chat_thread without `provider`
// (and without PD-1's `last_message`), so getDb()'s migrate() path — not just
// schema.sql's CREATE TABLE — is what the assertions exercise.
{
  const old = new Database(dbPath);
  old.exec(`
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
    INSERT INTO project VALUES ('p1', '/tmp/proj', 'proj', 1);
    INSERT INTO chat_thread (session_id, project_id, cwd, model, title, created_at, last_activity)
      VALUES ('pre-migration', 'p1', '/tmp/proj', NULL, 'old thread', 1, 1);
  `);
  old.close();
}

const { getDb, closeDb } = await import("../db/index.js");
const {
  adoptChatThread,
  getChatThread,
  listChatProjects,
  upsertChatThread,
} = await import("./threads.js");

test("migrate() adds provider, effort, and last_message to a pre-existing chat_thread", () => {
  const cols = getDb()
    .prepare("PRAGMA table_info(chat_thread)")
    .all()
    .map((c) => (c as { name: string }).name);
  assert.ok(cols.includes("provider"));
  assert.ok(cols.includes("last_message"));
  assert.ok(cols.includes("effort"));
});

test("a pre-migration row (provider NULL) reads as 'claude'", () => {
  const row = getChatThread("pre-migration");
  assert.ok(row);
  assert.equal(row.provider, "claude");
});

test("upsert records the launching provider; getChatThread returns it", () => {
  upsertChatThread({
    sessionId: "codex-1",
    projectId: "p1",
    cwd: "/tmp/proj",
    model: null,
    provider: "codex",
    effort: "high",
    title: "codex thread",
  });
  assert.equal(getChatThread("codex-1")?.provider, "codex");
  assert.equal(getChatThread("codex-1")?.effort, "high");
});

test("provider is sticky — a conflicting upsert never rewrites it", () => {
  upsertChatThread({
    sessionId: "codex-1",
    projectId: "p1",
    cwd: "/tmp/proj",
    model: null,
    provider: "grok",
    effort: "low",
    title: null,
  });
  assert.equal(getChatThread("codex-1")?.provider, "codex");
  assert.equal(getChatThread("codex-1")?.effort, "high");
});

test("upsert with provider null still reads as 'claude'", () => {
  upsertChatThread({
    sessionId: "legacy-1",
    projectId: "p1",
    cwd: "/tmp/proj",
    model: null,
    provider: null,
    title: null,
  });
  assert.equal(getChatThread("legacy-1")?.provider, "claude");
});

test("listChatProjects carries each thread's provider", () => {
  const proj = listChatProjects().find((p) => p.id === "p1");
  assert.ok(proj);
  const byId = new Map(proj.threads.map((t) => [t.sessionId, t.provider]));
  assert.equal(byId.get("codex-1"), "codex");
  assert.equal(byId.get("pre-migration"), "claude");
  assert.equal(byId.get("legacy-1"), "claude");
});

test("adoptChatThread keeps the provider across the resume re-key", () => {
  adoptChatThread("codex-1", "codex-1-forked");
  assert.equal(getChatThread("codex-1"), null);
  assert.equal(getChatThread("codex-1-forked")?.provider, "codex");
  assert.equal(getChatThread("codex-1-forked")?.effort, "high");
  closeDb();
});

// T3-11 (US-006): draft promotion. A draft is UI state — no row exists until
// the first turn — so what's testable here is the persistence half: promoting
// must land exactly ONE row, and re-entering the same session (the init event
// can re-fire, e.g. after a live permission-mode switch) must not add another.
test("promotion is idempotent — one session id yields exactly one row", () => {
  const rows = () =>
    (getDb()
      .prepare("SELECT COUNT(*) AS n FROM chat_thread WHERE session_id = ?")
      .get("promote-1") as { n: number }).n;

  upsertChatThread({
    sessionId: "promote-1",
    projectId: "p1",
    cwd: "/tmp/proj",
    model: "claude-fable-5",
    provider: "claude",
    effort: null,
    title: "promoted draft",
  });
  assert.equal(rows(), 1);

  // Same session re-upserted (re-emitted init) — still one row, config intact.
  upsertChatThread({
    sessionId: "promote-1",
    projectId: "p1",
    cwd: "/tmp/proj",
    model: "claude-fable-5",
    provider: "claude",
    effort: null,
    title: "promoted draft",
  });
  assert.equal(rows(), 1);

  const row = getChatThread("promote-1");
  assert.equal(row?.provider, "claude");
  assert.equal(row?.model, "claude-fable-5");
  assert.equal(row?.cwd, "/tmp/proj");
});
