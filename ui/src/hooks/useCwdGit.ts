import { useEffect, useState } from "react";

/** Git status for the active working directory (US-019). */
export interface CwdGit {
  available: boolean;
  branch: string | null;
  dirty: number;
}

/**
 * Loads git status for the app-wide active cwd from GET /api/cwd/git (US-019).
 * Unlike the per-session Git data, this is cwd-scoped: it re-fetches when the
 * active cwd changes (so the toolbar directory picker re-scopes it) and on each
 * WS event so the dirty count tracks edits. Only fetches when `enabled` (the Git
 * widget is on). Returns null until the first load / when disabled.
 */
export function useCwdGit(
  cwd: string | null,
  eventSeq: number | null,
  enabled: boolean,
): CwdGit | null {
  const [git, setGit] = useState<CwdGit | null>(null);

  useEffect(() => {
    if (!enabled || !cwd) {
      setGit(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cwd/git?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setGit((d?.git ?? null) as CwdGit | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd, eventSeq, enabled]);

  return git;
}
