import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Git status for an arbitrary directory (GET /api/fs/git, US-011). Mirrors
 *  the gateway's GitStatus — structural copy across the module boundary. */
export interface DirGit {
  available: boolean;
  branch: string | null;
  dirty: number;
}

/**
 * Branch + dirty count for a directory — the chat StatusBar's git source
 * (US-011). The terminal surface derives git from the correlated session's
 * widgets; chat threads have a cwd but not necessarily a correlated session,
 * so this polls the path directly (light: two 2s-capped git children server-side).
 *
 * `refreshKey` (WHA-196): when it changes, re-pull immediately. Callers pass a
 * value that moves when a chat turn `result` lands so the branch chip reflects
 * agent-side git work without waiting for the next 15s poll. The interval stays
 * as the backstop — do not shorten it (four git children per open thread).
 */
export function useDirGit(
  token: string | null,
  cwd: string | null,
  refreshKey: unknown = 0,
): DirGit | null {
  const [git, setGit] = useState<DirGit | null>(null);

  // Path/auth change → drop stale status so we never show another cwd's branch.
  // Refresh-key bumps deliberately do NOT clear: the previous reading stays
  // until the new pull lands (no chip flash on every turn end).
  useEffect(() => {
    setGit(null);
  }, [token, cwd]);

  useEffect(() => {
    if (!token || !cwd) return;
    let cancelled = false;
    const pull = () => {
      fetch(apiBase() + `/api/fs/git?path=${encodeURIComponent(cwd)}`, {
        headers: { "x-conan-token": token },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((g: DirGit | null) => {
          if (!cancelled && g) setGit(g);
        })
        .catch(() => {});
    };
    pull();
    const timer = setInterval(pull, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, cwd, refreshKey]);
  return git;
}
