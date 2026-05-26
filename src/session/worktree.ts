import { execFileSync } from "node:child_process";
import path from "node:path";

/** Details of a worktree minted for an isolated driven session (US-043). */
export interface WorktreeInfo {
  /** Absolute path of the new worktree — used as the session cwd. */
  path: string;
  /** New branch checked out in the worktree (`conan/<stamp>-<rand>`). */
  branch: string;
  /** Resolved base ref the branch was cut from (short sha when resolvable). */
  baseRef: string;
}

/** Absolute path to the git repo root containing `cwd`, or null if not a repo. */
export function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Create a fresh git worktree off `repoCwd`'s repository so a driven session
 * runs in isolation and parallel runs don't collide (US-043). Cuts a new branch
 * from `baseRef` (default HEAD) and places the worktree under
 * `<repo>/.conan-worktrees/<stamp>-<rand>`. Throws if `repoCwd` isn't a git repo.
 */
export function createWorktree(repoCwd: string, baseRef?: string): WorktreeInfo {
  const root = gitRoot(repoCwd);
  if (!root) throw new Error(`not a git repository: ${repoCwd}`);

  const base = baseRef && baseRef.trim() ? baseRef.trim() : "HEAD";
  // Resolve the base to a concrete short sha so the surfaced ref is meaningful;
  // fall back to the symbolic name if rev-parse can't resolve it.
  let resolved = base;
  try {
    resolved = execFileSync("git", ["rev-parse", "--short", base], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* keep the symbolic base */
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  const slug = `${stamp}-${rand}`;
  const branch = `conan/${slug}`;
  const wtPath = path.join(root, ".conan-worktrees", slug);

  execFileSync("git", ["worktree", "add", "-b", branch, wtPath, base], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });

  return { path: wtPath, branch, baseRef: resolved };
}

/**
 * Tear down a worktree created by {@link createWorktree} (US-043 cleanup):
 * `git worktree remove --force <path>`, run from the main repo (the command
 * refuses to run from inside the worktree being removed). Returns whether the
 * removal succeeded; a missing/already-removed worktree returns false.
 */
export function removeWorktree(wtPath: string): boolean {
  try {
    // --git-common-dir points at the *main* repo's .git even from a worktree;
    // its parent is the main repo root, a safe place to run `worktree remove`.
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: wtPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const mainRoot = path.dirname(path.resolve(wtPath, commonDir));
    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: mainRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
