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
 */
export function useDirGit(token: string | null, cwd: string | null): DirGit | null {
  const [git, setGit] = useState<DirGit | null>(null);
  useEffect(() => {
    setGit(null);
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
  }, [token, cwd]);
  return git;
}
