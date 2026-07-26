// Conan-managed git worktrees for branch-backed chat threads. Callers receive
// the repo checkout for its current branch, or a stable create-or-reuse path
// under ~/.conan/worktrees for every other branch.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectBranches } from "./branches.js";

export const WORKTREE_ROOT = path.join(os.homedir(), ".conan", "worktrees");

export interface EnsureWorktreeInput {
  cwd: string;
  branch: string;
  createBranch?: boolean;
  base?: string;
}

export interface EnsureWorktreeResult {
  path: string;
  created: boolean;
  reused: boolean;
}

export class WorktreeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeValidationError";
  }
}

const GIT_TIMEOUT_MS = 30_000;
let worktreeRootOverride: string | null = null;

export function setWorktreeRootForTests(dir: string | null): void {
  worktreeRootOverride = dir;
}

function worktreeRoot(): string {
  return worktreeRootOverride ?? WORKTREE_ROOT;
}

function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(error);
          return;
        }
        const code = error ? ((error as { code?: unknown }).code as number) ?? 1 : 0;
        resolve({
          stdout,
          stderr,
          code: typeof code === "number" ? code : 1,
        });
      },
    );
  });
}

function gitError(action: string, result: { stdout: string; stderr: string }): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(detail ? `${action}: ${detail}` : `${action} failed`);
}

export async function ensureWorktree(
  input: EnsureWorktreeInput,
): Promise<EnsureWorktreeResult> {
  const branch = input.branch.trim();
  // check-ref-format is repository-independent; use the gateway cwd so a
  // missing project path is still reported as "not a git repository" below.
  const validBranch = await runGit(process.cwd(), [
    "check-ref-format",
    "--branch",
    branch,
  ]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  if (!branch || validBranch.code !== 0) {
    throw new WorktreeValidationError(`invalid branch name: ${input.branch}`);
  }

  const branches = await collectBranches(input.cwd);
  if (!branches.repo || !branches.root) {
    throw new WorktreeValidationError(`not a git repository: ${input.cwd}`);
  }
  const repoRoot = branches.root;

  if (branches.current === branch) {
    return { path: repoRoot, created: false, reused: false };
  }

  const dirName = `${path.basename(repoRoot)}--${branch.replaceAll("/", "-")}`;
  const worktreePath = path.join(worktreeRoot(), dirName);
  if (fs.existsSync(worktreePath)) {
    const [top, checkedOutBranch] = await Promise.all([
      runGit(worktreePath, ["rev-parse", "--show-toplevel"]),
      runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    if (
      top.code === 0 &&
      path.resolve(top.stdout.trim()) === path.resolve(worktreePath) &&
      checkedOutBranch.code === 0 &&
      checkedOutBranch.stdout.trim() === branch
    ) {
      return { path: worktreePath, created: false, reused: true };
    }
  }

  if (input.createBranch) {
    const base = input.base?.trim() || branches.defaultBranch;
    if (!base) {
      throw new WorktreeValidationError(
        "cannot create branch: repository default branch could not be determined",
      );
    }
    const createdBranch = await runGit(repoRoot, ["branch", branch, base]);
    if (createdBranch.code !== 0) {
      throw gitError(`cannot create branch ${branch}`, createdBranch);
    }
  }

  fs.mkdirSync(worktreeRoot(), { recursive: true });
  const added = await runGit(repoRoot, ["worktree", "add", worktreePath, branch]);
  if (added.code !== 0) {
    throw gitError(`cannot add worktree for ${branch}`, added);
  }

  return { path: worktreePath, created: true, reused: false };
}

export async function pruneWorktreesAtBoot(): Promise<void> {
  const root = worktreeRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`Unable to scan Conan worktrees: ${(error as Error).message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const valid = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
      if (valid.code !== 0) continue;
      const pruned = await runGit(dir, ["worktree", "prune"]);
      if (pruned.code !== 0) throw gitError("git worktree prune", pruned);
    } catch (error) {
      console.warn(`Unable to prune worktrees via ${dir}: ${(error as Error).message}`);
    }
  }
}
