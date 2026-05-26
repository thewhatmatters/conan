import { useEffect, useState } from "react";

/** One hook event's coverage (mirrors the gateway's HookEventCoverage, US-009). */
export interface HookEventCoverage {
  event: string;
  description: string;
  /** Whether Conan has an ingestion path for this event. */
  consumedByConan: boolean;
  /** Whether a non-empty hook is configured for this event, per scope. */
  wired: { user: boolean; project: boolean };
}

export interface HooksCoveragePayload {
  events: HookEventCoverage[];
  consumed: string[];
  summary: {
    total: number;
    consumed: number;
    unconsumed: number;
    wiredUser: number;
    wiredProject: number;
  };
  scopes: { user: string[]; project: string[] };
}

export interface HooksCoverageState {
  data: HooksCoveragePayload | null;
  /** True until the first fetch settles. */
  loaded: boolean;
}

/**
 * Loads Conan's hook coverage (US-033) from GET /api/claude/hooks-coverage
 * (US-009): the full known Claude Code hook-event set, each marked
 * consumed-by-Conan and wired-or-not per settings scope (user + project).
 * Read-only. Refetches on each new WS event so freshly-wired hooks surface;
 * missing schema/settings degrade to a safe shape on the gateway side.
 */
export function useHooksCoverage(eventSeq: number | null): HooksCoverageState {
  const [state, setState] = useState<HooksCoverageState>({
    data: null,
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/hooks-coverage")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setState({
          data: d && Array.isArray(d.events) ? (d as HooksCoveragePayload) : null,
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [eventSeq]);

  return state;
}
