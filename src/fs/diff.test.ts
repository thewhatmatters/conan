// collectWorkingTreeDiff() backs POST /api/fs/diff (Conan Surfaces US-004):
// per-file unified diffs of a repo's uncommitted changes, honest {repo:false}
// for non-repo cwds, PathOutsideRepoError for escaping paths, and a byte cap
// with a truncated flag. Fixture repos are real `git init` tmpdirs. Run with
// `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  collectWorkingTreeDiff,
  parsePorcelainStatus,
  capPatch,
  MAX_PATCH_BYTES,
  PathOutsideRepoError,
} from "./diff.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@conan.sh", "-c", "user.name=conan-test", ...args],
    { cwd, stdio: "ignore" },
  );
}

/** Repo with one commit (a.txt, b.txt, sub/c.txt), then: a modified, b deleted,
 * new.txt untracked. Returns the (symlink-resolved) repo root. */
function makeDirtyRepo(): string {
  // realpathSync: macOS tmpdirs live under /var → /private/var; git reports the
  // resolved root, so resolve up front to keep path comparisons honest.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "conan-diff-test-")));
  git(root, "init", "-q");
  fs.writeFileSync(path.join(root, "a.txt"), "alpha line one\n");
  fs.writeFileSync(path.join(root, "b.txt"), "bravo\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "c.txt"), "charlie\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(root, "a.txt"), "alpha line one\nalpha line two\n");
  fs.rmSync(path.join(root, "b.txt"));
  fs.writeFileSync(path.join(root, "new.txt"), "hello from new\n");
  return root;
}

test("collects modified + deleted + untracked with real patches", async () => {
  const root = makeDirtyRepo();
  const result = await collectWorkingTreeDiff(root);
  assert.equal(result.repo, true);
  assert.equal(result.root, root);

  const byPath = new Map(result.files.map((f) => [f.path, f]));
  assert.deepEqual(
    [...byPath.keys()].sort(),
    ["a.txt", "b.txt", "new.txt"],
  );

  const modified = byPath.get("a.txt");
  assert.equal(modified?.status, "modified");
  assert.match(modified?.patch ?? "", /\+alpha line two/);
  assert.equal(modified?.truncated, false);

  const deleted = byPath.get("b.txt");
  assert.equal(deleted?.status, "deleted");
  assert.match(deleted?.patch ?? "", /-bravo/);

  const untracked = byPath.get("new.txt");
  assert.equal(untracked?.status, "untracked");
  assert.match(untracked?.patch ?? "", /\+hello from new/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a subdirectory cwd still resolves the repo root", async () => {
  const root = makeDirtyRepo();
  const result = await collectWorkingTreeDiff(path.join(root, "sub"));
  assert.equal(result.repo, true);
  assert.equal(result.root, root);
  assert.equal(result.files.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("paths narrows the set (relative to cwd)", async () => {
  const root = makeDirtyRepo();
  const result = await collectWorkingTreeDiff(root, ["a.txt"]);
  assert.deepEqual(
    result.files.map((f) => ({ path: f.path, status: f.status })),
    [{ path: "a.txt", status: "modified" }],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a path outside the repo root rejects", async () => {
  const root = makeDirtyRepo();
  await assert.rejects(
    collectWorkingTreeDiff(root, ["../escape.txt"]),
    PathOutsideRepoError,
  );
  await assert.rejects(
    collectWorkingTreeDiff(root, ["/etc/hosts"]),
    PathOutsideRepoError,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("non-repo cwd degrades to {repo:false, files:[]}", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-diff-norepo-"));
  assert.deepEqual(await collectWorkingTreeDiff(dir), {
    repo: false,
    root: null,
    files: [],
  });
  assert.deepEqual(await collectWorkingTreeDiff("/no/such/conan/dir"), {
    repo: false,
    root: null,
    files: [],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a huge patch is byte-capped with truncated:true", async () => {
  const root = makeDirtyRepo();
  const big = Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  fs.writeFileSync(path.join(root, "big.txt"), big + "\n");
  const result = await collectWorkingTreeDiff(root, ["big.txt"]);
  const file = result.files[0];
  assert.ok(file, "the big untracked file is reported");
  assert.equal(file.status, "untracked");
  assert.equal(file.truncated, true);
  assert.ok(Buffer.byteLength(file.patch, "utf8") <= MAX_PATCH_BYTES);
  fs.rmSync(root, { recursive: true, force: true });
});

test("clean repo answers repo:true with zero files", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "conan-diff-clean-")));
  git(root, "init", "-q");
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  assert.deepEqual(await collectWorkingTreeDiff(root), {
    repo: true,
    root,
    files: [],
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("parsePorcelainStatus maps XY codes and skips rename 'from' paths", () => {
  const raw = [
    "?? new.txt",
    " M mod.txt",
    "M  staged.txt",
    " D gone.txt",
    "A  added.txt",
    "R  renamed-to.txt\0renamed-from.txt",
  ].join("\0") + "\0";
  assert.deepEqual(parsePorcelainStatus(raw), [
    { path: "new.txt", status: "untracked" },
    { path: "mod.txt", status: "modified" },
    { path: "staged.txt", status: "modified" },
    { path: "gone.txt", status: "deleted" },
    { path: "added.txt", status: "added" },
    { path: "renamed-to.txt", status: "modified" },
  ]);
});

test("capPatch is a no-op under the cap and honest over it", () => {
  assert.deepEqual(capPatch("small"), { patch: "small", truncated: false });
  const over = capPatch("y".repeat(MAX_PATCH_BYTES + 10));
  assert.equal(over.truncated, true);
  assert.equal(Buffer.byteLength(over.patch, "utf8"), MAX_PATCH_BYTES);
});
