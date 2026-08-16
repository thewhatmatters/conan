/**
 * v2 branch adapter (p2c US-302).
 *
 * Thin re-export of v1's `useDirGit` — the branch/dirty poll behind
 * `GET /api/fs/git` that v1's chat StatusBar already uses. No new route, no
 * second poller: the composer's branch chip reads the same source the rest of
 * the app does (contract §4.5 — reuse through an adapter, never a fork).
 */
import { useDirGit, type DirGit } from "../../hooks/useDirGit.ts";

export type { DirGit };

/** Branch + uncommitted count for the active thread's cwd, or null until the
 *  first poll lands (and for a directory that is not a repo).
 *
 *  `refreshKey` (WHA-196) forwards to `useDirGit` — bump when a turn `result`
 *  lands so the chip re-pulls without waiting for the 15s backstop. */
export function useThreadGit(
  token: string | null,
  cwd: string | null,
  refreshKey: unknown = 0,
): DirGit | null {
  return useDirGit(token, cwd, refreshKey);
}
