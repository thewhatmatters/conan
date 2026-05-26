// US-020: time-series aggregation for the Pulse / throughput chart. Buckets the
// `event` table across ALL sessions into fixed time slices so the UI can plot
// events-per-minute and token/cost burn over time, and surface api_retry events
// distinctly. This is the time-series counterpart to the snapshot hero cards
// (US-010) — those describe "now", this describes the recent past.
import { getDb } from "../db/index.js";

/**
 * Activity categories the stacked-area Pulse chart stacks by (US-016). Order is
 * the stack order (bottom → top) and maps 1:1 onto --color-chart-1..5 in the UI.
 * Every meaningful (non-stream-delta) event falls into exactly one category, so
 * the per-bucket `types` always sum to `events`.
 */
export const PULSE_CATEGORIES = [
  { key: "tool", label: "Tools" },
  { key: "assistant", label: "Assistant" },
  { key: "prompt", label: "Prompts" },
  { key: "session", label: "Session" },
  { key: "other", label: "Other" },
] as const;

export type PulseCategory = (typeof PULSE_CATEGORIES)[number]["key"];

/** Bucket one event into a stack category from its stream/hook columns alone
 * (no payload parsing) so the breakdown is cheap and deterministic. */
function categorize(row: EventRow): PulseCategory {
  const h = row.hook_event_name;
  if (h === "PreToolUse" || h === "PostToolUse" || h === "PostToolUseFailure")
    return "tool";
  if (h === "UserPromptSubmit") return "prompt";
  if (
    h === "SessionStart" ||
    h === "SessionEnd" ||
    h === "Stop" ||
    h === "SubagentStop" ||
    h === "Notification" ||
    h === "PreCompact"
  )
    return "session";
  const s = row.stream_type;
  if (s === "assistant" || s === "result") return "assistant";
  return "other";
}

/** One time slice of activity aggregated across every session. */
export interface PulseBucket {
  /** Bucket start, epoch ms. */
  t: number;
  /** Meaningful events in this slice (stream-token deltas excluded as noise). */
  events: number;
  /** Per-category breakdown of `events` (stacked by the UI); sums to `events`. */
  types: Record<PulseCategory, number>;
  /** api_retry events in this slice, surfaced distinctly on the chart. */
  retries: number;
  /** Output tokens produced (from ResultMessage usage). */
  tokens: number;
  /** Cost attributed to this slice (USD), from per-session total_cost_usd deltas. */
  cost: number;
}

export interface PulseSeries {
  /** Window length covered, ms. */
  windowMs: number;
  /** Width of each bucket, ms. */
  bucketMs: number;
  /** Server clock at query time, ms — the right edge of the window. */
  now: number;
  buckets: PulseBucket[];
  totals: { events: number; retries: number; tokens: number; cost: number };
}

interface EventRow {
  session_id: string;
  stream_type: string | null;
  hook_event_name: string | null;
  payload: string | null;
  ts: number;
}

/** True for the high-frequency partial-token stream rows we exclude from the
 * activity rate so "events per minute" reflects real steps, not token deltas. */
function isStreamDelta(streamType: string | null): boolean {
  return streamType != null && streamType.startsWith("stream_event");
}

function isRetry(row: EventRow): boolean {
  return (
    row.stream_type === "system/api_retry" ||
    row.hook_event_name === "PostToolUseFailure"
  );
}

/**
 * Aggregate recent activity into ~60 evenly-spaced buckets over `windowMs`.
 * Token/cost figures come from `result` rows: output_tokens is per-turn, and
 * cost is derived from the per-session delta of the cumulative total_cost_usd
 * (so a session's running total isn't recounted into every bucket).
 */
export function pulseSeries(windowMs = 60 * 60 * 1000): PulseSeries {
  const now = Date.now();
  const start = now - windowMs;

  // Aim for ~60 buckets, snapped to whole minutes (min 1 minute per bucket).
  const bucketMs = Math.max(
    60_000,
    Math.round(windowMs / 60 / 60_000) * 60_000,
  );
  const count = Math.max(1, Math.ceil(windowMs / bucketMs));

  const zeroTypes = (): Record<PulseCategory, number> => ({
    tool: 0,
    assistant: 0,
    prompt: 0,
    session: 0,
    other: 0,
  });

  const buckets: PulseBucket[] = Array.from({ length: count }, (_, i) => ({
    t: start + i * bucketMs,
    events: 0,
    types: zeroTypes(),
    retries: 0,
    tokens: 0,
    cost: 0,
  }));

  const idxFor = (ts: number): number => {
    const i = Math.floor((ts - start) / bucketMs);
    return i < 0 ? -1 : i >= count ? count - 1 : i;
  };

  const db = getDb();

  // Event counts + retries within the window.
  const rows = db
    .prepare(
      `SELECT session_id, stream_type, hook_event_name, ts
         FROM event
        WHERE ts >= ?
        ORDER BY ts ASC`,
    )
    .all(start) as EventRow[];

  for (const row of rows) {
    const i = idxFor(row.ts);
    const b = i < 0 ? undefined : buckets[i];
    if (!b) continue;
    if (isRetry(row)) b.retries++;
    if (!isStreamDelta(row.stream_type)) {
      b.events++;
      b.types[categorize(row)]++;
    }
  }

  // Token/cost from result rows. Walk ALL result rows in time order so the
  // per-session cost delta has a correct baseline even when the prior result
  // fell outside the window; only attribute slices that land inside it.
  const results = db
    .prepare(
      `SELECT session_id, payload, ts
         FROM event
        WHERE stream_type = 'result'
        ORDER BY ts ASC`,
    )
    .all() as EventRow[];

  const lastCost = new Map<string, number>();
  for (const row of results) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      payload = null;
    }
    const cumulative =
      payload && typeof payload.total_cost_usd === "number"
        ? payload.total_cost_usd
        : undefined;
    const usage =
      payload && typeof payload.usage === "object"
        ? (payload.usage as Record<string, unknown>)
        : undefined;
    const outTokens =
      usage && typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : 0;

    let costDelta = 0;
    if (cumulative !== undefined) {
      const prev = lastCost.get(row.session_id) ?? 0;
      // A drop means a fresh/relaunched session — count the new value whole.
      costDelta = cumulative >= prev ? cumulative - prev : cumulative;
      lastCost.set(row.session_id, cumulative);
    }

    const i = idxFor(row.ts);
    const b = i < 0 ? undefined : buckets[i];
    if (!b) continue; // outside the window: baseline only, not plotted.
    b.tokens += outTokens;
    b.cost += costDelta;
  }

  const totals = buckets.reduce(
    (acc, b) => ({
      events: acc.events + b.events,
      retries: acc.retries + b.retries,
      tokens: acc.tokens + b.tokens,
      cost: acc.cost + b.cost,
    }),
    { events: 0, retries: 0, tokens: 0, cost: 0 },
  );

  return { windowMs, bucketMs, now, buckets, totals };
}
