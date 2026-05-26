import { useCallback, useEffect, useState } from "react";
import type { UltrareviewRun } from "./useTasks.ts";

export type { UltrareviewRun };

export interface UltrareviewState {
  /** The current/last run, or null until one has been launched. */
  run: UltrareviewRun | null;
  /** True until the first snapshot fetch settles. */
  loaded: boolean;
  /** True while a launch request is in flight. */
  starting: boolean;
  /** A short error from the last start/stop attempt, or null. */
  actionError: string | null;
  /** Launch a review for the active repo (optionally a GitHub PR #). */
  start: (pr?: string) => void;
  /** Stop an in-flight review. */
  stop: () => void;
}

/**
 * Ultrareview control + findings stream (US-046). Seeds from GET
 * /api/claude/ultrareview on mount, then overlays the live `lastUltrareview`
 * pushed over /ws so the panel renders the streamed output without polling.
 * `start()`/`stop()` are token-gated POSTs — explicit, billed user actions.
 */
export function useUltrareview(
  lastUltrareview: UltrareviewRun | null,
  token: string | null,
): UltrareviewState {
  const [run, setRun] = useState<UltrareviewRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Initial snapshot — recover any run already in flight on (re)load.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/ultrareview")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setRun(d?.run ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live stream: each pushed run for the same id (or a newer one) supersedes.
  useEffect(() => {
    if (lastUltrareview) setRun(lastUltrareview);
  }, [lastUltrareview]);

  const start = useCallback(
    (pr?: string) => {
      if (!token || starting) return;
      setStarting(true);
      setActionError(null);
      fetch("/api/claude/ultrareview", {
        method: "POST",
        headers: { "content-type": "application/json", "x-conan-token": token },
        body: JSON.stringify(pr ? { pr } : {}),
      })
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setActionError(typeof d?.error === "string" ? d.error : "failed to start");
            return;
          }
          if (d?.run) setRun(d.run as UltrareviewRun);
        })
        .catch(() => setActionError("request failed"))
        .finally(() => setStarting(false));
    },
    [token, starting],
  );

  const stop = useCallback(() => {
    if (!token) return;
    setActionError(null);
    fetch("/api/claude/ultrareview/stop", {
      method: "POST",
      headers: { "x-conan-token": token },
    }).catch(() => setActionError("request failed"));
  }, [token]);

  return { run, loaded, starting, actionError, start, stop };
}
