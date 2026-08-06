/**
 * Pure model for the v2 context-window meter (WHA-101).
 *
 * Mirrors the honesty rules of v1's ContextMeter in ChatPane:
 *   - No position yet → absent (don't invent a zero).
 *   - Position known, window unknown → raw count, no percentage (codex-class).
 *   - Both known → count + percentage; warn ≥75%, error ≥90%.
 */

export type ContextMeterVariant = "default" | "warning" | "error" | "neutral";

export interface ContextMeterState {
  /** 0–100 when the window size is known; null when only the raw count is honest. */
  pct: number | null;
  variant: ContextMeterVariant;
  /** Compact used token count for the card header. */
  usedLabel: string;
  /** Compact window size, or null when unknown. */
  windowLabel: string | null;
  /** One-line summary next to the title (e.g. "23% · 45k/200k" or "45k tokens"). */
  summary: string;
  /** Body copy explaining what the meter is (or why there's no %). */
  detail: string;
}

export type ContextPressureStatus = {
  type: "warning" | "error";
  message: string;
};

/** Compact token count — same thresholds as v1's fmtTokens. */
export function fmtTokens(n: number): string {
  const compact = (v: number, suffix: string) =>
    `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${suffix}`;
  if (n >= 1_000_000) return compact(n / 1_000_000, "M");
  if (n >= 10_000) return compact(n / 1000, "k");
  return n.toLocaleString();
}

/**
 * Derive the meter face. Returns null when nothing should render (no usage
 * reported yet — a zeroed ring would lie about an empty measured window).
 */
export function contextMeterState(
  used: number | null | undefined,
  windowTokens: number | null | undefined,
): ContextMeterState | null {
  if (used == null) return null;
  const windowKnown =
    windowTokens != null && Number.isFinite(windowTokens) && windowTokens > 0;
  const pct = windowKnown
    ? Math.min(100, (used / (windowTokens as number)) * 100)
    : null;
  const variant: ContextMeterVariant =
    pct == null ? "neutral" : pct >= 90 ? "error" : pct >= 75 ? "warning" : "default";
  const usedLabel = fmtTokens(used);
  const windowLabel = windowKnown ? fmtTokens(windowTokens as number) : null;
  const summary =
    pct != null && windowLabel != null
      ? `${Math.round(pct)}% · ${usedLabel}/${windowLabel}`
      : `${usedLabel} tokens`;
  const detail =
    pct != null
      ? "Tokens the conversation is carrying (input + cached). Grows each turn."
      : "This provider reports no context-window size, so no percentage is shown — only the raw count.";
  return { pct, variant, usedLabel, windowLabel, summary, detail };
}

/**
 * The composer validation/status rail is reserved for pressure that needs a
 * user decision. Normal and unknown-window states stay quiet; warning/error
 * states say how to recover instead of merely repeating the percentage.
 */
export function contextPressureStatus(
  state: ContextMeterState | null,
): ContextPressureStatus | undefined {
  if (state?.variant === "warning") {
    return {
      type: "warning",
      message: `Context is ${Math.round(state.pct ?? 0)}% full. Start a new thread soon to keep responses reliable.`,
    };
  }
  if (state?.variant === "error") {
    return {
      type: "error",
      message: `Context is ${Math.round(state.pct ?? 0)}% full. Start a new thread to preserve earlier details.`,
    };
  }
  return undefined;
}
