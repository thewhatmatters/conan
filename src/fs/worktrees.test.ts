import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureWorktree,
  setWorktreeRootForTests,
} from "./worktrees.js";

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@conan.sh", "-c", "user.name=conan-test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function makeFixture(): { repo: string; worktrees: string } {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "conan-worktrees-test-")),
  );
  cleanup.push(parent);
  const repo = path.join(parent, "repo");
  const worktrees = path.join(parent, "managed");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  setWorktreeRootForTests(worktrees);
  return { repo, worktrees };
}

afterEach(() => {
  setWorktreeRootForTests(null);
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates a worktree for an existing branch", async () => {
  const { repo, worktrees } = makeFixture();
  git(repo, "branch", "feature");

  const result = await ensureWorktree({ cwd: repo, branch: "feature" });

  assert.deepEqual(result, {
    path: path.join(worktrees, "repo--feature"),
    created: true,
    reused: false,
  });
  assert.equal(git(result.path, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
});

test("reuses the Conan-managed worktree for the same branch", async () => {
  const { repo } = makeFixture();
  git(repo, "branch", "feature");
  const first = await ensureWorktree({ cwd: repo, branch: "feature" });

  const second = await ensureWorktree({ cwd: repo, branch: "feature" });

  assert.deepEqual(second, {
    path: first.path,
    created: false,
    reused: true,
  });
  assert.deepEqual(fs.readdirSync(path.dirname(first.path)), ["repo--feature"]);
});

test("returns the repo root when its current branch is selected", async () => {
  const { repo, worktrees } = makeFixture();

  assert.deepEqual(await ensureWorktree({ cwd: repo, branch: "main" }), {
    path: repo,
    created: false,
    reused: false,
  });
  assert.equal(fs.existsSync(worktrees), false);
});

test("creates a new branch from the repository default branch", async () => {
  const { repo } = makeFixture();

  const result = await ensureWorktree({
    cwd: repo,
    branch: "feature/new",
    createBranch: true,
  });

  assert.equal(result.created, true);
  assert.equal(git(result.path, "rev-parse", "--abbrev-ref", "HEAD"), "feature/new");
  assert.equal(git(repo, "show-ref", "--verify", "--quiet", "refs/heads/feature/new"), "");
});

test("rejects an invalid branch name with a readable error", async () => {
  const { repo } = makeFixture();

  await assert.rejects(
    ensureWorktree({ cwd: repo, branch: "bad name" }),
    /invalid branch name: bad name/,
  );
});
