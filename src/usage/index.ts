// US-030: data source for the "Usage" hero widget — the dashboard counterpart
// to run-tasks.sh's reactive usage-limit backoff (which surfaces a reset time
// and resumes the current story after a Claude usage/rate limit).
//
// Three things power the widget:
//   - current usage: cost + output-tokens recorded *today* across all sessions
//     (and a percent against the daily cost ceiling when one is configured);
//   - a rate-limited state, detected from recent `system/api_retry` events that
//     look like a rate-limit (and ResultMessage rows carrying rate-limit info);
//   - a reset time parsed from that retry's payload, so the UI can count down.
//
// The parsing helpers are pure and exported so they can be unit-tested against
// the various shapes a retry/limit payload can take (the headless rate-limit
// path can't be exercised live without an API key + a real 429).

import { getDb } from "../db/index.js";
import { readBudgetSettings } from "../settings/index.js";

export interface UsageStatus {
  /** Server clock at query time, epoch ms — the basis for the countdown. */
  now: number;
  /** Cost recorded today across sessions (USD), mirrors the Cost-today widget. */
  costToday: number;
  /** Output tokens produced today (sum of per-turn ResultMessage usage). */
  tokensToday: number;
  /** Configured daily cost ceiling (USD), or null when none is set. */
  dailyCeilingUsd: number | null;
  /** costToday / ceiling as a percent, or null when no ceiling is set. */
  pct: number | null;
  /** True when a recent retry looks like an unresolved rate limit. */
  rateLimited: boolean;
  /** When the limit is expected to reset (epoch ms), or null when unknown. */
  resetAt: number | null;
  /** True when we have any usage figure to show (else the widget shows "—"). */
  hasData: boolean;
}

/** Start of the local day in epoch ms — the window for "today". */
function startOfToday(): number {
  return new Date().setHours(0, 0, 0, 0);
}

/** How far back a rate-limit retry stays "current" if nothing resolved it. */
const RATE_LIMIT_LOOKBACK_MS = 60 * 60 * 1000;

interface EventRow {
  session_id: string;
  stream_type: string | null;
  payload: string | null;
  ts: number;
}

function safeParse(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const v = JSON.parse(payload);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Does this payload describe a rate limit (as opposed to a transient network /
 * overloaded retry)? We look across the obvious shapes Claude Code / the
 * Anthropic API surface: an `error.type` of rate_limit_error, an HTTP 429
 * status, or the substring "rate limit" / "usage limit" anywhere in the text.
 */
export function isRateLimitPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;

  // Structured: error.type === "rate_limit_error", or a 429 status anywhere.
  const error = p.error as Record<string, unknown> | undefined;
  if (error && typeof error === "object") {
    if (error.type === "rate_limit_error") return true;
    const inner = error.error as Record<string, unknown> | undefined;
    if (inner && inner.type === "rate_limit_error") return true;
  }
  for (const key of ["status", "statusCode", "status_code"]) {
    if (p[key] === 429) return true;
  }

  // Textual: scan the serialized payload for limit phrasing.
  const text = JSON.stringify(p).toLowerCase();
  return (
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("usage limit") ||
    text.includes("429")
  );
}

/** Coerce a numeric/string time-ish value into epoch ms, or null. */
function toEpochMs(v: unknown, eventTs: number): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 0) return null;
    // Heuristic: seconds since epoch (~10 digits) vs. ms (~13 digits) vs. a
    // small "seconds from now" delay.
    if (v < 1_000_000) return eventTs + v * 1000; // delay in seconds
    if (v < 1e12) return v * 1000; // unix seconds
    return v; // already ms
  }
  if (typeof v === "string" && v.trim()) {
    const s = v.trim();
    if (/^\d+$/.test(s)) return toEpochMs(Number(s), eventTs);
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Recursively search an object for the first matching key (case-insensitive). */
function findKey(obj: unknown, keys: string[], depth = 0): unknown {
  if (depth > 4 || !obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (keys.includes(k.toLowerCase())) return rec[k];
  }
  for (const k of Object.keys(rec)) {
    const found = findKey(rec[k], keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Best-effort reset time (epoch ms) from a retry/limit payload. Tries the field
 * names the Anthropic API and CLI use, in priority order, then falls back to a
 * "resets at 3[:00]pm"-style phrase in any message text (matching the same
 * intent as run-tasks.sh's reset_seconds parser).
 */
export function parseResetAt(payload: unknown, eventTs: number): number | null {
  if (!payload || typeof payload !== "object") return null;

  // Absolute reset timestamps (headers / structured fields).
  const resetVal = findKey(payload, [
    "anthropic-ratelimit-unified-reset",
    "ratelimit-reset",
    "reset_at",
    "resetat",
    "resetsat",
    "resets_at",
    "reset",
  ]);
  const fromReset = toEpochMs(resetVal, eventTs);
  if (fromReset && fromReset > eventTs) return fromReset;

  // Relative delays (seconds from the event).
  const retryVal = findKey(payload, [
    "retry_after",
    "retryafter",
    "retry-after",
    "retry_after_seconds",
    "delay_ms",
    "delayms",
  ]);
  if (typeof retryVal === "number" && Number.isFinite(retryVal) && retryVal > 0) {
    // delay_ms is milliseconds; everything else is seconds.
    const ms = retryVal > 100_000 ? retryVal : retryVal * 1000;
    return eventTs + ms;
  }

  // Textual "resets at 3pm" / "resets at 15:30" in any message string.
  const text = JSON.stringify(payload);
  const m = /reset[^0-9]*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (m) {
    let hour = parseInt(m[1] ?? "", 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = m[3]?.toLowerCase();
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && min >= 0 && min <= 59) {
      const d = new Date(eventTs);
      d.setHours(hour, min, 0, 0);
      let t = d.getTime();
      if (t <= eventTs) t += 24 * 60 * 60 * 1000; // next occurrence
      // A reset >6h out is suspect (limit windows are short) — ignore, same
      // guard run-tasks.sh uses.
      if (t - eventTs <= 6 * 60 * 60 * 1000) return t;
    }
  }

  return null;
}

/**
 * Evaluate current usage + rate-limit state across all sessions. "Today"
 * mirrors the Cost-today / budget windows; the rate-limited flag is set when
 * the most recent rate-limit retry hasn't been followed by a successful
 * (non-retry) event, i.e. the agent is still blocked.
 */
export function usageStatus(): UsageStatus {
  const now = Date.now();
  const today = startOfToday();
  const db = getDb();

  // Cost today, from the session rows (total_cost_usd folded in by the parser).
  const sessionRows = db
    .prepare(
      `SELECT total_cost_usd, last_activity FROM session WHERE last_activity >= ?`,
    )
    .all(today) as { total_cost_usd: number; last_activity: number }[];
  const costToday = sessionRows.reduce(
    (sum, r) => sum + (r.total_cost_usd || 0),
    0,
  );

  // Output tokens today, summed from result rows (per-turn usage).
  const resultRows = db
    .prepare(
      `SELECT payload FROM event WHERE stream_type = 'result' AND ts >= ?`,
    )
    .all(today) as { payload: string | null }[];
  let tokensToday = 0;
  for (const r of resultRows) {
    const p = safeParse(r.payload);
    const usage = p?.usage as Record<string, unknown> | undefined;
    const out = usage?.output_tokens;
    if (typeof out === "number" && Number.isFinite(out)) tokensToday += out;
  }

  // Rate-limit detection: the newest api_retry across sessions within the
  // lookback window. If it looks like a rate limit and nothing succeeded after
  // it, treat the agent as currently rate-limited and surface its reset time.
  const retries = db
    .prepare(
      `SELECT session_id, stream_type, payload, ts
         FROM event
        WHERE stream_type = 'system/api_retry' AND ts >= ?
        ORDER BY ts DESC LIMIT 20`,
    )
    .all(now - RATE_LIMIT_LOOKBACK_MS) as EventRow[];

  let rateLimited = false;
  let resetAt: number | null = null;
  for (const row of retries) {
    const payload = safeParse(row.payload);
    if (!isRateLimitPayload(payload ?? {})) continue;
    // Has anything non-retry happened on this session since the retry? If so,
    // the limit cleared and we're no longer blocked. (Ignore the synthetic
    // budget Notification from US-023, which carries no stream_type.)
    const later = db
      .prepare(
        `SELECT 1 FROM event
           WHERE session_id = ? AND ts > ?
             AND (stream_type IS NULL OR stream_type != 'system/api_retry')
             AND COALESCE(hook_event_name, '') != 'Notification'
           LIMIT 1`,
      )
      .get(row.session_id, row.ts);
    if (later) continue;
    rateLimited = true;
    resetAt = parseResetAt(payload, row.ts);
    break;
  }

  const ceiling = readBudgetSettings().dailyCostCeilingUsd;
  const dailyCeilingUsd = ceiling && ceiling > 0 ? ceiling : null;
  const pct = dailyCeilingUsd ? (costToday / dailyCeilingUsd) * 100 : null;

  return {
    now,
    costToday,
    tokensToday,
    dailyCeilingUsd,
    pct,
    rateLimited,
    resetAt,
    hasData: costToday > 0 || tokensToday > 0 || rateLimited,
  };
}
