// Local branch metadata for the branch picker. The route stays a thin
// validator; non-repo directories degrade to an honest empty result.

import { execFile } from "node:child_process";

export interface BranchesResult {
  repo: boolean;
  root: string | null;
  current: string | null;
  defaultBranch: string | null;
  branches: string[];
}

const GIT_TIMEOUT_MS = 30_000;

function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(error);
          return;
        }
        const code = error ? ((error as { code?: unknown }).code as number) ?? 1 : 0;
        resolve({ stdout, code: typeof code === "number" ? code : 1 });
      },
    );
  });
}

export async function collectBranches(cwd: string): Promise<BranchesResult> {
  const none: BranchesResult = {
    repo: false,
    root: null,
    current: null,
    defaultBranch: null,
    branches: [],
  };

  let root: string;
  try {
    const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || !top.stdout.trim()) return none;
    root = top.stdout.trim();
  } catch {
    return none;
  }

  const currentResult = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentName = currentResult.code === 0 ? currentResult.stdout.trim() : "";
  const current = currentName && currentName !== "HEAD" ? currentName : null;

  const branchesResult = await runGit(root, [
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:short)",
  ]);
  const branches =
    branchesResult.code === 0
      ? branchesResult.stdout
          .split("\n")
          .map((branch) => branch.trim())
          .filter(Boolean)
          .sort()
      : [];

  const originHead = await runGit(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  const originRef = originHead.code === 0 ? originHead.stdout.trim() : "";
  const defaultBranch = originRef.startsWith("refs/remotes/origin/")
    ? originRef.slice("refs/remotes/origin/".length)
    : branches.includes("main")
      ? "main"
      : branches.includes("master")
        ? "master"
        : null;

  return { repo: true, root, current, defaultBranch, branches };
}
