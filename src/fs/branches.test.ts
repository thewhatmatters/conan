import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectBranches } from "./branches.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@conan.sh", "-c", "user.name=conan-test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function makeRepo(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "conan-branches-test-")),
  );
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

test("collects sorted local branches and the current branch", async () => {
  const root = makeRepo();
  git(root, "branch", "zebra");
  git(root, "branch", "alpha");
  git(root, "checkout", "-q", "alpha");

  assert.deepEqual(await collectBranches(root), {
    repo: true,
    root,
    current: "alpha",
    defaultBranch: "main",
    branches: ["alpha", "main", "zebra"],
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("non-repo cwd returns the empty non-repo shape", async () => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "conan-branches-norepo-")),
  );
  assert.deepEqual(await collectBranches(dir), {
    repo: false,
    root: null,
    current: null,
    defaultBranch: null,
    branches: [],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("detached HEAD reports no current branch", async () => {
  const root = makeRepo();
  const sha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", sha);

  const result = await collectBranches(root);
  assert.equal(result.repo, true);
  assert.equal(result.current, null);
  assert.deepEqual(result.branches, ["main"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("uses main as the default branch when origin/HEAD is absent", async () => {
  const root = makeRepo();
  git(root, "branch", "feature");

  const result = await collectBranches(root);
  assert.equal(result.defaultBranch, "main");
  fs.rmSync(root, { recursive: true, force: true });
});
