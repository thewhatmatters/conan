// WHA-136 (A1): the attempt → project resolver. A path is not an identity —
// the same checkout answers to a symlinked path, its real path, and every
// nested cwd inside it. All of them must land on one project row, or the
// lineage ledger reads one project as several.
//
// Runs against a throwaway SQLite file with real directories on disk (the
// symlink cases cannot be faked) — env is pointed at a temp dir BEFORE the db
// module, which captures paths at import. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-project-test-"));
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = path.join(dataDir, "conan.db");

const { resolveProjectId } = await import("./project.js");
const { openAttempt } = await import("./attempts.js");
const { upsertChatProject } = await import("../agent/threads.js");
const { getDb } = await import("../db/index.js");

/** A directory tree that looks like a checkout: `.git` at the root, a nested
 *  package below it, and a symlink pointing at the whole thing. */
function fixture(name: string): { root: string; nested: string; link: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `conan-${name}-`));
  const root = path.join(base, "repo");
  const nested = path.join(root, "packages", "api");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  const link = path.join(base, "link-to-repo");
  fs.symlinkSync(root, link, "dir");
  return { root, nested, link };
}

test("a symlinked path and the real path are one project", () => {
  const { root, link } = fixture("symlink");
  // The sidebar adopted the SYMLINK — which is what happens on this machine,
  // where ~/.buzz/REPOS is a symlink to ~/Development. A spawn reporting the
  // real path must still find it.
  const project = upsertChatProject(link, "linked");
  assert.equal(resolveProjectId(root), project.id, "real path missed the symlinked project");
  assert.equal(resolveProjectId(link), project.id, "symlinked path missed its own project");
});

test("a nested cwd resolves to the repo's project", () => {
  const { root, nested } = fixture("nested");
  const project = upsertChatProject(root, "monorepo");
  // AC3: no project row exists for packages/api, so the repo root answers.
  assert.equal(resolveProjectId(nested), project.id);
});

test("an explicitly adopted subdirectory wins over the repo root", () => {
  const { root, nested } = fixture("subdir");
  const outer = upsertChatProject(root, "monorepo");
  const inner = upsertChatProject(nested, "api");
  assert.equal(resolveProjectId(nested), inner.id, "most specific project must win");
  assert.equal(resolveProjectId(root), outer.id);
  assert.notEqual(outer.id, inner.id);
});

test("a cwd under no project resolves to null, never a near miss", () => {
  const { root } = fixture("orphan");
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "conan-stranger-"));
  upsertChatProject(root, "adopted");
  assert.equal(resolveProjectId(stranger), null);
});

test("a trailing slash is not a different project", () => {
  const { root } = fixture("slash");
  const project = upsertChatProject(root, "slashy");
  assert.equal(resolveProjectId(`${root}/`), project.id);
});

test("a project whose folder was deleted matches nothing and does not throw", () => {
  const { root } = fixture("deleted");
  upsertChatProject(root, "gone");
  fs.rmSync(root, { recursive: true, force: true });
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "conan-after-delete-"));
  assert.equal(resolveProjectId(stranger), null);
});

test("a git worktree is a separate project from its checkout", () => {
  // Pinning a decision, not discovering one (WHA-136, confirmed by Hermes):
  // worktrees share an object database but have distinct working trees and
  // branches, so lineage from one is not lineage from the other. A future
  // reader who assumes "same repo = same project" should fail here.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "conan-worktree-"));
  const main = path.join(base, "main");
  fs.mkdirSync(main);
  const git = (cwd: string, args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  };
  git(main, ["init", "-q", "-b", "main"]);
  git(main, ["config", "user.email", "test@example.com"]);
  git(main, ["config", "user.name", "test"]);
  fs.writeFileSync(path.join(main, "f.txt"), "x");
  git(main, ["add", "f.txt"]);
  git(main, ["commit", "-qm", "init"]);
  const linked = path.join(base, "wt");
  git(main, ["worktree", "add", "-q", "-b", "side", linked]);

  const project = upsertChatProject(main, "main-checkout");
  assert.equal(resolveProjectId(main), project.id);
  assert.equal(
    resolveProjectId(linked),
    null,
    "a worktree must not inherit the main checkout's project",
  );
});

test("no cwd resolves to null", () => {
  assert.equal(resolveProjectId(null), null);
  assert.equal(resolveProjectId(""), null);
});

test("a folder with no git root still matches its own project row", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "conan-plain-"));
  const project = upsertChatProject(plain, "plain");
  assert.equal(resolveProjectId(plain), project.id);
});

test("openAttempt anchors the row to the resolved project", () => {
  const { root, nested, link } = fixture("attempt");
  const project = upsertChatProject(link, "attempt-project");
  const id = openAttempt({
    context: "chat",
    provider: "claude",
    model: null,
    permissionMode: "default",
    containment: "prompt-gated",
    // A spawn deep inside the tree, reported by its real path — two hops from
    // the string the project was adopted under.
    cwd: nested,
  });
  assert.ok(id, "attempt was not written");
  const row = getDb()
    .prepare("SELECT project_id, cwd FROM attempt WHERE id = ?")
    .get(id) as { project_id: string | null; cwd: string };
  assert.equal(row.project_id, project.id);
  assert.equal(row.cwd, nested, "cwd must still record where the process actually ran");
  assert.ok(root); // fixture sanity
});

test("an attempt outside every project still records, with a null project", () => {
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), "conan-unowned-"));
  const id = openAttempt({
    context: "chat",
    provider: "kimi",
    model: null,
    permissionMode: null,
    containment: "none",
    cwd: stranger,
  });
  assert.ok(id, "an unowned spawn must still be recorded");
  const row = getDb()
    .prepare("SELECT project_id FROM attempt WHERE id = ?")
    .get(id) as { project_id: string | null };
  assert.equal(row.project_id, null);
});
