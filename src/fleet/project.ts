// WHA-136 (A1): which project an attempt belongs to.
//
// Resolved ONCE, at attempt creation, and stored — never re-derived at read
// time by matching `cwd` strings. A path is not an identity: the same checkout
// answers to as many strings as there are symlinks pointing at it (on this
// machine `~/.buzz/REPOS` is a symlink to `~/Development`, so one repo has two
// absolute paths), and a nested cwd inside a monorepo is a third. Every one of
// those must resolve to the same project row or the lineage ledger splits one
// project into several.
//
// KNOWN BEHAVIOUR, deliberate: a git *worktree* is a DIFFERENT project from the
// checkout it was created from. They share an object database but have distinct
// working trees, distinct branches and distinct files, so lineage from one is
// not lineage from the other — and `git rev-parse --show-toplevel` would say the
// same. "Same repo" is therefore not "same project". Collapsing them would mean
// keying on the git common dir instead of the working tree root; do not "fix"
// this without changing that decision on purpose.
import fs from "node:fs";
import { getDb } from "../db/index.js";
import { findRepoRoot } from "../agent/threads.js";

/** Canonical form of a directory: symlinks resolved, trailing slash stripped.
 *  Two strings naming the same directory must produce the same output here.
 *  Null when the path no longer exists — a deleted folder matches nothing
 *  rather than matching everything. */
function canonical(dir: string): string | null {
  try {
    return fs.realpathSync.native(dir).replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

/**
 * The project id for a spawn's working directory, or null when no project row
 * covers it (a chat started in a folder the sidebar never adopted).
 *
 * Candidates are tried most-specific first: the cwd itself, then its repo root.
 * The order matters — a user who explicitly added `repo/packages/api` as a
 * project means that project, not the monorepo above it. Falling through to the
 * repo root is what makes a nested cwd land on the same project as the root
 * (AC3) instead of missing entirely.
 */
export function resolveProjectId(cwd: string | null): string | null {
  if (!cwd) return null;

  const candidates: string[] = [];
  for (const dir of [cwd, findRepoRoot(cwd)]) {
    if (!dir) continue;
    const c = canonical(dir);
    if (c && !candidates.includes(c)) candidates.push(c);
  }
  if (!candidates.length) return null;

  let rows: Array<{ id: string; path: string }>;
  try {
    rows = getDb().prepare("SELECT id, path FROM project").all() as Array<{
      id: string;
      path: string;
    }>;
  } catch (err) {
    console.warn(`[fleet] project lookup failed: ${(err as Error).message}`);
    return null;
  }

  // Canonicalised once per lookup rather than stored normalised: project rows
  // are written by the UI and changing their `path` would move sidebar rows.
  // The list is small and a spawn is rare, so the stat cost is irrelevant.
  const byPath = new Map<string, string>();
  for (const row of rows) {
    const c = canonical(row.path);
    if (c && !byPath.has(c)) byPath.set(c, row.id);
  }

  for (const candidate of candidates) {
    const id = byPath.get(candidate);
    if (id) return id;
  }
  return null;
}
