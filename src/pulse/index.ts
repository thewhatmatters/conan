// US-020: time-series aggregation for the Pulse / throughput chart. Buckets the
// `event` table across ALL sessions into fixed time slices so the UI can plot
// events-per-minute and token/cost burn over time, and surface api_retry events
// distinctly. This is the time-series counterpart to the snapshot hero cards
// (US-010) — those describe "now", this describes the recent past.
import fs from "node:fs";
import { getDb } from "../db/index.js";
import { readAssistantTurnUsages, transcriptPath } from "../transcript/index.js";

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
  /** Total tokens spent in assistant turns ending in this slice (sum of
   *  input + cache_read + cache_creation + output, from the transcript JSONL). */
  tokens: number;
  /** The cache_read_input_tokens slice of `tokens` — the prior-context
   *  replay that almost always dominates the total without representing
   *  any new work. The UI subtracts this to show a "new tokens" footer
   *  number alongside the cache reads. */
  cacheReadTokens: number;
  /** Reserved for cost (USD) once a source lands; currently always 0. */
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
  totals: {
    events: number;
    retries: number;
    tokens: number;
    cacheReadTokens: number;
    cost: number;
  };
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
 * Per-bucket tokens come from the transcript JSONL (`readAssistantTurnUsages`)
 * for every session with events in the window — Conan's hook ingestion never
 * carries a usage block, so the transcript is the canonical source.
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
    cacheReadTokens: 0,
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

  // Tokens come from the Claude Code transcript JSONLs at
  // ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl — every assistant
  // message there carries a `usage` block with input + cache + output. We
  // don't ingest the old stream-json `result` rows since the headless-drive
  // path was removed in v4.2, so the transcript is the canonical source.
  // Cached by file path + mtime so repeated Pulse polls don't re-read
  // unchanged sessions; cleared whenever the JSONL grows.
  const sessions = db
    .prepare(
      `SELECT DISTINCT e.session_id, s.cwd
         FROM event e
         LEFT JOIN session s ON s.id = e.session_id
        WHERE e.ts >= ?`,
    )
    .all(start) as { session_id: string; cwd: string | null }[];

  for (const { session_id, cwd } of sessions) {
    const usages = readCachedTurnUsages(session_id, cwd);
    for (const u of usages) {
      const i = idxFor(u.ts);
      const b = i < 0 ? undefined : buckets[i];
      if (!b) continue;
      b.tokens += u.totalTokens;
      b.cacheReadTokens += u.cacheReadTokens;
    }
  }

  const totals = buckets.reduce(
    (acc, b) => ({
      events: acc.events + b.events,
      retries: acc.retries + b.retries,
      tokens: acc.tokens + b.tokens,
      cacheReadTokens: acc.cacheReadTokens + b.cacheReadTokens,
      cost: acc.cost + b.cost,
    }),
    { events: 0, retries: 0, tokens: 0, cacheReadTokens: 0, cost: 0 },
  );

  return { windowMs, bucketMs, now, buckets, totals };
}

/**
 * Module-level cache for per-session transcript-turn usages, keyed by the
 * resolved JSONL path with mtime invalidation. Pulse polls every few seconds
 * and 24h windows can pull a dozen sessions; without this we'd re-read every
 * (possibly multi-MB) JSONL on every request.
 */
const turnUsageCache = new Map<
  string,
  {
    mtimeMs: number;
    usages: { ts: number; totalTokens: number; cacheReadTokens: number }[];
  }
>();

function readCachedTurnUsages(
  sessionId: string,
  cwd: string | null,
): { ts: number; totalTokens: number; cacheReadTokens: number }[] {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const hit = turnUsageCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.usages;
  const usages = readAssistantTurnUsages(sessionId, cwd);
  turnUsageCache.set(file, { mtimeMs, usages });
  return usages;
}
