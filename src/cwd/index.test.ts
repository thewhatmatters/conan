// listEntries() backs the File Explorer panel: unlike listDirs (dirs-only, for
// the toolbar picker) it returns files AND directories, keeps dotfiles, sorts
// directories first then case-insensitively by name, and degrades unreadable
// targets to an empty listing with an `error` rather than throwing. Run with
// `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listEntries, looksLikeProject, searchFiles } from "./index.js";

/** Build a throwaway directory tree and return its root path. */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conan-fs-test-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".hidden-dir"));
  fs.writeFileSync(path.join(root, "zeta.txt"), "z");
  fs.writeFileSync(path.join(root, "alpha.ts"), "a");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {}");
  return root;
}

test("lists files AND directories, directories first then name-sorted", () => {
  const root = makeTree();
  const listing = listEntries(root);
  assert.equal(listing.error, undefined);
  const names = listing.entries.map((e) => e.name);
  // Dirs first (.hidden-dir, src — themselves name-sorted), then files
  // (.env, alpha.ts, zeta.txt — name-sorted). Dotfiles are kept.
  assert.deepEqual(names, [".hidden-dir", "src", ".env", "alpha.ts", "zeta.txt"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("entries carry isDir + a size for files", () => {
  const root = makeTree();
  const listing = listEntries(root);
  const src = listing.entries.find((e) => e.name === "src");
  const alpha = listing.entries.find((e) => e.name === "alpha.ts");
  assert.equal(src?.isDir, true);
  assert.equal(alpha?.isDir, false);
  assert.ok((alpha?.size ?? 0) > 0, "a non-empty file reports a positive size");
  assert.ok(alpha?.path.endsWith("/alpha.ts"), "entry path is absolute");
  fs.rmSync(root, { recursive: true, force: true });
});

test("parent is the containing dir, null only at the fs root", () => {
  const root = makeTree();
  const listing = listEntries(root);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listEntries("/").parent, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unreadable target degrades to an empty listing with an error", () => {
  const listing = listEntries("/no/such/conan/dir/" + Date.now());
  assert.deepEqual(listing.entries, []);
  assert.match(listing.error ?? "", /cannot read/);
});

// searchFiles() backs the composer's @ autocomplete (US-018): a bounded
// breadth-first walk with case-insensitive name matching, hidden entries
// opted in by a leading-dot query, rel-path matching for queries with `/`,
// dependency-dir skipping, and prefix-match-first ranking.

/** A deeper throwaway tree for the recursive search tests. */
function makeSearchTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conan-search-test-"));
  fs.mkdirSync(path.join(root, "src", "agent"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "react"), { recursive: true });
  fs.writeFileSync(path.join(root, "readme.md"), "r");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {}");
  fs.writeFileSync(path.join(root, "src", "agent", "driver.ts"), "export {}");
  fs.writeFileSync(path.join(root, "node_modules", "react", "driver.ts"), "x");
  return root;
}

test("search finds nested files by name, skipping node_modules", () => {
  const root = makeSearchTree();
  const r = searchFiles(root, "driver");
  assert.deepEqual(
    r.hits.map((h) => h.rel),
    ["src/agent/driver.ts"],
  );
  assert.equal(r.truncated, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("empty query returns shallow-first entries; hidden excluded by default", () => {
  const root = makeSearchTree();
  const r = searchFiles(root, "");
  const rels = r.hits.map((h) => h.rel);
  assert.ok(rels.includes("src"), "top-level dir listed");
  assert.ok(rels.includes("readme.md"), "top-level file listed");
  assert.ok(!rels.includes(".env"), "hidden file excluded without a dot query");
  // Skip-dirs are excluded from RECURSION, not from matching: the folder
  // itself is a legitimate @-mention target, its contents are not.
  assert.ok(rels.includes("node_modules"), "skip-dir itself still listed");
  assert.ok(!rels.some((rel) => rel.startsWith("node_modules/")), "nothing under a skip-dir");
  assert.ok(rels.indexOf("src") < rels.indexOf("src/index.ts"), "shallow before deep");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a leading-dot query opts hidden entries in", () => {
  const root = makeSearchTree();
  const r = searchFiles(root, ".env");
  assert.deepEqual(r.hits.map((h) => h.rel), [".env"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a query containing / matches the relative path", () => {
  const root = makeSearchTree();
  const r = searchFiles(root, "agent/dri");
  assert.deepEqual(r.hits.map((h) => h.rel), ["src/agent/driver.ts"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("prefix matches on the name rank before substring matches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conan-search-test-"));
  fs.writeFileSync(path.join(root, "my-index.ts"), "a");
  fs.writeFileSync(path.join(root, "index.ts"), "b");
  const r = searchFiles(root, "index");
  assert.deepEqual(
    r.hits.map((h) => h.rel),
    ["index.ts", "my-index.ts"],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("search on an unreadable root degrades to an error", () => {
  const r = searchFiles("/no/such/conan/dir/" + Date.now(), "x");
  assert.deepEqual(r.hits, []);
  assert.match(r.error ?? "", /cannot read/);
});

// looksLikeProject() gates WHA-83's boot-time auto-create. With nothing
// persisted the gateway's cwd is ~/.claude (smartDefault), and a project's
// name is its basename — so without this gate a first-run user gets a project
// called ".claude" pointing at their Claude Code config. Randy chose `smart`
// (2026-08-16): auto-create only when the cwd is actually a codebase.

/** A throwaway dir under a fresh root, built by `build`. */
function makeDir(build: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-proj-test-"));
  build(dir);
  return dir;
}

test("looksLikeProject accepts a normal clone (.git is a directory)", () => {
  const dir = makeDir((d) => fs.mkdirSync(path.join(d, ".git")));
  assert.equal(looksLikeProject(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("looksLikeProject accepts a worktree (.git is a FILE)", () => {
  // The case a `statSync(...).isDirectory()` check would wrongly reject —
  // every worktree under conan-worktrees/ has .git as a pointer file.
  const dir = makeDir((d) =>
    fs.writeFileSync(path.join(d, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n"),
  );
  assert.equal(looksLikeProject(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("looksLikeProject rejects a config dir like ~/.claude", () => {
  // The exact shape that made the gate necessary: real, readable, full of
  // files, and not a codebase.
  const dir = makeDir((d) => {
    fs.writeFileSync(path.join(d, "settings.json"), "{}");
    fs.mkdirSync(path.join(d, "projects"));
  });
  assert.equal(looksLikeProject(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("looksLikeProject rejects a bare home-like dir with no .git", () => {
  const dir = makeDir((d) => fs.mkdirSync(path.join(d, "Documents")));
  assert.equal(looksLikeProject(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("looksLikeProject rejects a nonexistent path", () => {
  assert.equal(looksLikeProject("/no/such/conan/dir/" + Date.now()), false);
});

test("looksLikeProject rejects ~/.claude even when it is a git repo", () => {
  // Caught by live QA, not by the temp-dir tests above: a version-controlled
  // ~/.claude is common (this machine's has a remote), so a bare `.git` test
  // reported it as a codebase and would still have auto-created the exact
  // ".claude" project the gate exists to prevent. Asserts against the REAL
  // home directory — that is the whole point.
  const home = os.homedir();
  assert.equal(looksLikeProject(path.join(home, ".claude")), false);
  assert.equal(looksLikeProject(home), false);
  // A trailing slash resolves to the same directory and must not slip past.
  assert.equal(looksLikeProject(path.join(home, ".claude") + "/"), false);
});

test("looksLikeProject rejects a file, not just a missing path", () => {
  const dir = makeDir((d) => fs.writeFileSync(path.join(d, "repo"), ""));
  assert.equal(looksLikeProject(path.join(dir, "repo")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
