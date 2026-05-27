// US-002: adaptive /context auto-refresh policy.
//
// US-001 refreshed /context on EVERY Stop hook (throttled only by a fixed 90s
// spacing). But each /context dump costs ~4-6k tokens injected into the live
// session — so a fixed cadence inflates and burns the very context it measures
// (the observer effect), even on turns where context barely moved.
//
// This module makes the refresh delta-triggered: it injects only after enough
// output has accumulated since the last capture, bounded by
//   - a HARD FLOOR (never refresh more often than the min spacing — tiny,
//     back-to-back turns can't trigger a costly inject), and
//   - a CEILING (a slow-but-long-running session still refreshes eventually so
//     the widget can't go stale forever).
//
// The decision is a PURE function (unit-tested in scripts/test-context.mjs); the
// per-session byte accumulator below is fed by the gateway's event ingest
// (PostToolUse tool_response sizes + any assistant message text) — tool outputs
// are the dominant driver of context growth between turns.

/** Clamp an integer env override into [min,max], falling back when unset/invalid. */
function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Hard floor: min ms between auto injects (tiny turns can't refresh). */
export const CONTEXT_MIN_SPACING_MS = clampEnvInt(
  "CONAN_CONTEXT_MIN_SPACING_MS",
  90_000,
  1_000,
  60 * 60_000,
);
/** Ceiling: a session this long since its last refresh refreshes regardless of delta. */
export const CONTEXT_MAX_SPACING_MS = clampEnvInt(
  "CONAN_CONTEXT_MAX_SPACING_MS",
  10 * 60_000,
  60_000,
  24 * 60 * 60_000,
);
/** Output bytes since the last capture that count as "context likely moved a lot". */
export const CONTEXT_DELTA_BYTES = clampEnvInt(
  "CONAN_CONTEXT_DELTA_BYTES",
  40_000,
  1_000,
  100 * 1024 * 1024,
);

/** Inputs to the (pure) auto-refresh decision; spacing/threshold default to the consts. */
export interface AutoRefreshDecisionInput {
  /** Now, epoch ms. */
  now: number;
  /** When the last auto inject was issued (epoch ms; 0 = never). */
  lastRefreshAt: number;
  /** Output bytes accumulated since the last capture. */
  deltaBytes: number;
  minSpacingMs?: number;
  maxSpacingMs?: number;
  deltaThresholdBytes?: number;
}

/**
 * Decide whether an auto /context inject is warranted right now. Pure — no I/O,
 * no clock — so the floor/ceiling/threshold behavior is unit-testable.
 *
 * Order matters: the floor wins over both the ceiling and the delta (a refresh
 * that just happened is never re-issued); past the floor, the ceiling forces a
 * refresh on a long-idle-but-running session; between the two, only a delta over
 * the threshold triggers.
 */
export function shouldAutoRefreshContext(input: AutoRefreshDecisionInput): boolean {
  const min = input.minSpacingMs ?? CONTEXT_MIN_SPACING_MS;
  const max = input.maxSpacingMs ?? CONTEXT_MAX_SPACING_MS;
  const threshold = input.deltaThresholdBytes ?? CONTEXT_DELTA_BYTES;
  const elapsed = input.now - input.lastRefreshAt;
  if (elapsed < min) return false; // hard floor: too soon since the last inject
  if (elapsed >= max) return true; // ceiling: refresh eventually even on small deltas
  return input.deltaBytes >= threshold; // delta: context has likely moved a lot
}

// --- per-session output accumulator ----------------------------------------

const growth = new Map<string, number>();

/** Add output bytes for a session (no-op for empty/invalid input). */
export function recordContextGrowth(sessionId: string, bytes: number): void {
  if (!sessionId || !Number.isFinite(bytes) || bytes <= 0) return;
  growth.set(sessionId, (growth.get(sessionId) ?? 0) + bytes);
}

/** Output bytes accumulated for a session since its last reset. */
export function getContextGrowth(sessionId: string): number {
  return growth.get(sessionId) ?? 0;
}

/** Clear a session's accumulator (called once an inject is actually issued). */
export function resetContextGrowth(sessionId: string): void {
  growth.delete(sessionId);
}
