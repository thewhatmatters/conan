// US-004 (was US-030): data source for the "Usage" hero widget — the dashboard
// counterpart to run-tasks.sh's reactive usage-limit backoff (which surfaces a
// reset time and resumes the current story after a Claude usage/rate limit).
//
// Claude Max is subscription/token-based, not dollar-metered, so usage is framed
// around plan limits + token consumption rather than a cost ceiling. The live
// plan-usage % lives only in the claude process's `anthropic-ratelimit-unified-*`
// response headers (Conan only shells out stream-json, so it can't read them) —
// so the honest signal is an api_retry-derived rate-limited flag + reset time
// plus our own token-consumption trend over recent rolling windows.
//
// Three things power the widget:
//   - a rate-limited state, detected from recent `system/api_retry` events that
//     look like a rate-limit (and ResultMessage rows carrying rate-limit info);
//   - a reset time parsed from that retry's payload, so the UI can count down;
//   - token consumption over rolling windows (last 5h / 7d) from the session
//     token columns, with cost-today retained only as informational.
//
// The parsing helpers are pure and exported so they can be unit-tested against
// the various shapes a retry/limit payload can take (the headless rate-limit
// path can't be exercised live without an API key + a real 429).

import { getDb } from "../db/index.js";

/** Output-token consumption over recent rolling windows (plan-usage trend). */
export interface TokensRecent {
  /** Output tokens across sessions active in the last 5 hours. */
  last5h: number;
  /** Output tokens across sessions active in the last 7 days. */
  last7d: number;
}

export interface UsageStatus {
  /** Server clock at query time, epoch ms — the basis for the countdown. */
  now: number;
  /** Cost recorded today across sessions (USD) — informational, NOT a ceiling. */
  costToday: number;
  /** Output tokens produced today (sum of per-turn ResultMessage usage). */
  tokensToday: number;
  /** Token consumption over rolling windows — the plan-usage trend. */
  tokensRecent: TokensRecent;
  /** True when a recent retry looks like an unresolved rate limit. */
  rateLimited: boolean;
  /** When the limit is expected to reset (epoch ms), or null when unknown. */
  resetAt: number | null;
  /** True when we have any usage figure to show (else the widget shows "—"). */
  hasData: boolean;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Evaluate current usage + rate-limit state across all sessions. "Today" is the
 * informational cost window; the rolling 5h/7d windows are the plan-usage token
 * trend; the rate-limited flag is set when the most recent rate-limit retry
 * hasn't been followed by a successful (non-retry) event, i.e. the agent is
 * still blocked.
 */
export function usageStatus(): UsageStatus {
  const now = Date.now();
  const today = startOfToday();
  const db = getDb();

  // Session token + cost rows, scoped to the widest window we care about (7d),
  // so we can derive both the today cost and the rolling token windows.
  const sessionRows = db
    .prepare(
      `SELECT total_cost_usd, output_tokens, last_activity
         FROM session
        WHERE last_activity >= ?`,
    )
    .all(now - SEVEN_DAYS_MS) as {
    total_cost_usd: number | null;
    output_tokens: number | null;
    last_activity: number;
  }[];

  // Cost today (informational only, NOT a ceiling): sessions active today.
  const costToday = sessionRows
    .filter((r) => r.last_activity >= today)
    .reduce((sum, r) => sum + (r.total_cost_usd || 0), 0);

  // Token consumption over rolling windows, from the session token columns.
  const fiveHoursAgo = now - FIVE_HOURS_MS;
  let recent5h = 0;
  let recent7d = 0;
  for (const r of sessionRows) {
    const out = r.output_tokens || 0;
    recent7d += out;
    if (r.last_activity >= fiveHoursAgo) recent5h += out;
  }
  const tokensRecent: TokensRecent = { last5h: recent5h, last7d: recent7d };

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

  return {
    now,
    costToday,
    tokensToday,
    tokensRecent,
    rateLimited,
    resetAt,
    hasData:
      costToday > 0 ||
      tokensToday > 0 ||
      tokensRecent.last7d > 0 ||
      rateLimited,
  };
}
