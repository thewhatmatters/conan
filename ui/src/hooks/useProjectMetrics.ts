import { useEffect, useState } from "react";

/** Per-model token/cost split from the last session (mirrors the backend). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

/** Last-session metrics for a project (GET /api/claude/project-metrics, US-010). */
export interface ProjectMetrics {
  cwd: string;
  /** Whether ~/.claude.json had an entry for this cwd. */
  found: boolean;
  lastCost: number | null;
  lastTotalInputTokens: number | null;
  lastTotalOutputTokens: number | null;
  lastTotalCacheCreationInputTokens: number | null;
  lastTotalCacheReadInputTokens: number | null;
  lastLinesAdded: number | null;
  lastLinesRemoved: number | null;
  lastDuration: number | null;
  lastSessionId: string | null;
  lastModelUsage: ModelUsage[];
}

/**
 * Loads the active cwd's last-session metrics from GET /api/claude/project-metrics
 * (US-010 backend). Like the Git widget data, this is cwd-scoped: it re-fetches
 * when the active cwd changes (so the toolbar directory picker re-scopes it) and
 * on each WS event so a freshly-finished session's numbers surface. Only fetches
 * when `enabled` (the Metrics widget is on). Returns null until the first load /
 * when disabled; the backend always responds with a safe `found:false` shape for
 * an unknown project, so the widget never errors.
 */
export function useProjectMetrics(
  cwd: string | null,
  eventSeq: number | null,
  enabled: boolean,
): ProjectMetrics | null {
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null);

  useEffect(() => {
    if (!enabled || !cwd) {
      setMetrics(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/claude/project-metrics?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setMetrics((d ?? null) as ProjectMetrics | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd, eventSeq, enabled]);

  return metrics;
}
