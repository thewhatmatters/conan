// Working-tree git diffs for the Diff surface (Conan Surfaces US-004).
// Pure collection/shaping logic behind POST /api/fs/diff — the route handler
// stays a thin validator. Everything degrades honestly: a non-repo cwd is
// `{repo:false, files:[]}`, never a throw; only paths escaping the repo root
// reject (a PathOutsideRepoError the route maps to a 400).

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export type DiffFileStatus = "modified" | "added" | "deleted" | "untracked";

export interface DiffFile {
  /** Repo-root-relative path. */
  path: string;
  status: DiffFileStatus;
  /** Unified diff text, capped at MAX_PATCH_BYTES. */
  patch: string;
  truncated: boolean;
}

export interface DiffResult {
  repo: boolean;
  /** Absolute repo root, null when cwd is not inside a repo. */
  root: string | null;
  files: DiffFile[];
}

/** Requested path resolves outside the repo root — the route returns 400. */
export class PathOutsideRepoError extends Error {
  constructor(p: string) {
    super(`path outside repo root: ${p}`);
    this.name = "PathOutsideRepoError";
  }
}

/** Per-file patch cap so one giant diff can't wedge the response. */
export const MAX_PATCH_BYTES = 128 * 1024;

const GIT_TIMEOUT_MS = 30_000;

/**
 * Run git, resolving stdout + exit code instead of rejecting on non-zero exit
 * (`git diff --no-index` exits 1 whenever the files differ). Rejects only on
 * spawn-level failures (git missing), which callers treat as "no repo".
 */
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

/**
 * Parse `git status --porcelain=v1 -z` output into {path, status} entries.
 * Rename/copy entries carry a second NUL-separated "from" path, which is
 * consumed and dropped — the surface shows the current (new) path as modified.
 */
export function parsePorcelainStatus(
  raw: string,
): { path: string; status: DiffFileStatus }[] {
  const tokens = raw.split("\0");
  const out: { path: string; status: DiffFileStatus }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue; // "XY p" minimum
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    if (x === "R" || x === "C") i++; // skip the rename/copy "from" path
    let status: DiffFileStatus;
    if (x === "?" && y === "?") status = "untracked";
    else if (x === "D" || y === "D") status = "deleted";
    else if (x === "A") status = "added";
    else status = "modified";
    out.push({ path: p, status });
  }
  return out;
}

/** Cap a patch at MAX_PATCH_BYTES (UTF-8 bytes), flagging truncation. */
export function capPatch(patch: string): { patch: string; truncated: boolean } {
  const buf = Buffer.from(patch, "utf8");
  if (buf.byteLength <= MAX_PATCH_BYTES) return { patch, truncated: false };
  return {
    patch: buf.subarray(0, MAX_PATCH_BYTES).toString("utf8"),
    truncated: true,
  };
}

/**
 * Normalize requested paths to repo-root-relative form. Relative inputs
 * resolve against cwd (how the UI naturally holds them); anything landing
 * outside the repo root throws PathOutsideRepoError.
 */
function toRootRelative(root: string, cwd: string, paths: string[]): string[] {
  return paths.map((p) => {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathOutsideRepoError(p);
    }
    return rel;
  });
}

/**
 * Collect this repo's uncommitted (working tree + index vs HEAD) changes as
 * per-file unified diffs. `paths` narrows the set; omitted → all changes.
 */
export async function collectWorkingTreeDiff(
  cwd: string,
  paths?: string[],
): Promise<DiffResult> {
  const none: DiffResult = { repo: false, root: null, files: [] };
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return none;
  } catch {
    return none;
  }

  let root: string;
  try {
    const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return none;
    root = top.stdout.trim();
    if (!root) return none;
  } catch {
    return none; // git itself missing
  }

  // Path validation happens before any status/diff work so a bad request
  // rejects without partial output. (Throws PathOutsideRepoError.)
  const rels = paths?.length ? toRootRelative(root, cwd, paths) : undefined;

  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  if (rels) statusArgs.push("--", ...rels);
  const status = await runGit(root, statusArgs);
  if (status.code !== 0) return { repo: true, root, files: [] };
  const entries = parsePorcelainStatus(status.stdout);

  // A fresh repo with no commits has no HEAD to diff against; everything
  // tracked there renders via the same /dev/null path untracked files use.
  const hasHead =
    (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;

  const files: DiffFile[] = [];
  for (const entry of entries) {
    let raw = "";
    try {
      if (entry.status === "untracked" || !hasHead) {
        const abs = path.join(root, entry.path);
        if (fs.existsSync(abs)) {
          raw = (
            await runGit(root, ["diff", "--no-index", "--", "/dev/null", entry.path])
          ).stdout;
        }
      } else {
        raw = (await runGit(root, ["diff", "HEAD", "--", entry.path])).stdout;
      }
    } catch {
      raw = ""; // per-file diff failure degrades to an empty patch
    }
    files.push({ path: entry.path, status: entry.status, ...capPatch(raw) });
  }

  return { repo: true, root, files };
}
