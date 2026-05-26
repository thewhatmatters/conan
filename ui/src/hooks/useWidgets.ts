import { useEffect, useState } from "react";

/** One category in the on-disk context approximation (US-007). */
export interface ContextCategory {
  key: "system" | "tools" | "mcp" | "memory" | "skills" | "messages";
  label: string;
  tokens: number;
}

/** Mirrors the WidgetData shape from src/widgets/index.ts (US-010). */
export interface WidgetData {
  mcp: { name: string; status: string }[] | null;
  git: { available: boolean; branch: string | null; dirty: number };
  /** Latest assistant turn's context consumption from the transcript (US-013). */
  context: { used: number; model: string | null } | null;
  /** On-disk per-category context approximation (US-007). */
  contextBreakdown: { categories: ContextCategory[]; approxTotal: number };
}

/**
 * Loads the opt-in secondary-widget data for the active session from
 * GET /api/claude/sessions/:id/widgets (US-022). Only fetches when `enabled`
 * (i.e. at least one secondary widget is turned on) so the default view makes
 * no extra request. Refetches as WS events arrive via `eventSeq`.
 */
export function useWidgets(
  sessionId: string | null,
  eventSeq: number | null,
  enabled: boolean,
): WidgetData | null {
  const [data, setData] = useState<WidgetData | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setData(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/claude/sessions/${encodeURIComponent(sessionId)}/widgets`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d as WidgetData);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, eventSeq, enabled]);

  return data;
}
