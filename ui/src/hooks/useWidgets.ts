import { useCallback, useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** One category in the on-disk context approximation (US-007). */
export interface ContextCategory {
  key: "system" | "tools" | "mcp" | "memory" | "skills" | "messages";
  label: string;
  tokens: number;
}

/** One category from the live /context capture (US-009) — includes Free space. */
export interface LiveContextCategory {
  key: "system" | "tools" | "mcp" | "memory" | "skills" | "messages" | "free";
  label: string;
  tokens: number;
  /** Percent of the context window this category occupies, as /context renders. */
  pct: number;
}

/** The exact /context breakdown captured from the live pty (US-009). */
export interface LiveContext {
  model: string | null;
  modelDisplay: string | null;
  usedTokens: number | null;
  windowTokens: number | null;
  usedPct: number | null;
  categories: LiveContextCategory[];
  capturedAt: number;
}

/** Mirrors the WidgetData shape from src/widgets/index.ts (US-010). */
export interface WidgetData {
  mcp: { name: string; status: string }[] | null;
  git: { available: boolean; branch: string | null; dirty: number };
  /** Latest assistant turn's context consumption from the transcript (US-013). */
  context: {
    used: number;
    model: string | null;
    /** Resolved context-window size (1M-aware) the gateway computed. */
    windowTokens?: number;
  } | null;
  /** On-disk per-category context approximation (US-007). */
  contextBreakdown: { categories: ContextCategory[]; approxTotal: number };
  /** Exact /context capture from the live pty, or null (US-009). */
  liveContext: LiveContext | null;
  /** Whether the session has a live correlated pty right now (US-009). */
  hasLivePty: boolean;
}

/**
 * Loads the opt-in secondary-widget data for the active session from
 * GET /api/claude/sessions/:id/widgets (US-022). Only fetches when `enabled`
 * (i.e. at least one secondary widget is turned on) so the default view makes
 * no extra request. Refetches as WS events arrive via `eventSeq`, and on demand
 * via the returned `refetch` (used by the Context widget's /context Refresh,
 * US-009, to re-pull after a passive capture lands).
 */
export function useWidgets(
  sessionId: string | null,
  eventSeq: number | null,
  enabled: boolean,
): { data: WidgetData | null; refetch: () => void } {
  const [data, setData] = useState<WidgetData | null>(null);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setData(null);
      return;
    }
    let cancelled = false;
    fetch(
      apiBase() +
        `/api/claude/sessions/${encodeURIComponent(sessionId)}/widgets`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d as WidgetData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, eventSeq, enabled, nonce]);

  return { data, refetch };
}
