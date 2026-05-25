// US-002: data source for the Stats / contribution-heatmap widget (US-015).
// Claude Code maintains its own usage rollup at ~/.claude/stats-cache.json —
// per-day activity, per-model token totals, hour-of-day histogram, lifetime
// session/message counts. We read it (never write it) and normalize it into a
// shape the UI can render directly: a *contiguous* day calendar (the on-disk
// dailyActivity is sparse — only days with activity appear) plus a handful of
// computed headline stats (streaks, favorite model/hour, total tokens).
//
// Cost is deliberately NOT taken from this file: stats-cache.json's costUSD is
// always 0. Dollar figures come from the DB's session.total_cost_usd elsewhere.
//
// readStats() takes an explicit path so tests can point it at a fixture, the
// same way the reaper takes its sessions dir; it defaults to the real file and
// degrades to a safe empty shape when the file is missing or unparseable.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

const STATS_PATH = path.join(HOME, ".claude", "stats-cache.json");

/** One day of activity as the UI consumes it (after zero-filling gaps). */
export interface DailyActivity {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

/** Normalized stats payload returned by GET /api/claude/stats. */
export interface StatsPayload {
  /** Contiguous day calendar (no gaps) from the first to the last known day. */
  dailyActivity: DailyActivity[];
  /** Sum of inputTokens + outputTokens across all models. */
  totalTokens: number;
  /** Same, including cache read + creation tokens (cache dwarfs the rest). */
  totalTokensWithCache: number;
  /** Count of days that had any activity. */
  activeDays: number;
  /** Consecutive active days ending at the most recent day in the range. */
  currentStreak: number;
  /** Longest run of consecutive active days anywhere in the range. */
  longestStreak: number;
  /** Model with the most input+output tokens, or null when none. */
  favoriteModel: string | null;
  /** Hour-of-day (0–23) with the most sessions, or null when none. */
  favoriteHour: number | null;
  /** ISO timestamp of the very first session, or null. */
  firstSessionDate: string | null;
  /** Lifetime session count (from the cache). */
  totalSessions: number;
  /** Lifetime message count (from the cache). */
  totalMessages: number;
  /** False when stats-cache.json was missing/empty — the widget shows "—". */
  hasData: boolean;
}

/** The (loosely-typed) on-disk stats-cache.json shape we care about. */
interface RawStats {
  dailyActivity?: Array<{
    date?: string;
    messageCount?: number;
    sessionCount?: number;
    toolCallCount?: number;
  }>;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
  hourCounts?: Record<string, number>;
  totalSessions?: number;
  totalMessages?: number;
  firstSessionDate?: string;
  lastComputedDate?: string;
}

function emptyPayload(): StatsPayload {
  return {
    dailyActivity: [],
    totalTokens: 0,
    totalTokensWithCache: 0,
    activeDays: 0,
    currentStreak: 0,
    longestStreak: 0,
    favoriteModel: null,
    favoriteHour: null,
    firstSessionDate: null,
    totalSessions: 0,
    totalMessages: 0,
    hasData: false,
  };
}

/** Parse a YYYY-MM-DD as a UTC day; NaN if malformed. */
function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Format an epoch-ms (a UTC midnight) back to YYYY-MM-DD. */
function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const ONE_DAY = 86_400_000;

/**
 * Expand a sparse list of active days into a contiguous calendar from the
 * earliest to the latest known day (inclusive), zero-filling every gap. The
 * range end also honors lastComputedDate, so trailing idle days are shown.
 * Pure + exported for unit testing.
 */
export function zeroFillDailyActivity(
  raw: RawStats["dailyActivity"],
  lastComputedDate?: string,
): DailyActivity[] {
  const present = new Map<string, DailyActivity>();
  for (const d of raw ?? []) {
    if (!d || typeof d.date !== "string" || Number.isNaN(dayMs(d.date))) continue;
    present.set(d.date, {
      date: d.date,
      messageCount: d.messageCount ?? 0,
      sessionCount: d.sessionCount ?? 0,
      toolCallCount: d.toolCallCount ?? 0,
    });
  }
  if (present.size === 0) return [];

  const days = [...present.keys()].map(dayMs).sort((a, b) => a - b);
  const start = Math.min(...days);
  let end = Math.max(...days);
  if (lastComputedDate && !Number.isNaN(dayMs(lastComputedDate))) {
    end = Math.max(end, dayMs(lastComputedDate));
  }

  const out: DailyActivity[] = [];
  for (let t = start; t <= end; t += ONE_DAY) {
    const key = dayStr(t);
    out.push(
      present.get(key) ?? {
        date: key,
        messageCount: 0,
        sessionCount: 0,
        toolCallCount: 0,
      },
    );
  }
  return out;
}

/**
 * Compute the longest run of consecutive active days and the current streak
 * (the active run ending at the last day of the contiguous range — 0 if the
 * last day is idle). Expects the already-zero-filled, date-ordered list.
 * Pure + exported for unit testing.
 */
export function computeStreaks(daily: DailyActivity[]): {
  currentStreak: number;
  longestStreak: number;
} {
  let longest = 0;
  let run = 0;
  for (const d of daily) {
    if (d.messageCount > 0 || d.sessionCount > 0 || d.toolCallCount > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // `run` now holds the trailing run length = the current streak.
  return { currentStreak: run, longestStreak: longest };
}

/** Normalize a parsed stats-cache.json object. Pure + exported for testing. */
export function normalizeStats(raw: RawStats | null): StatsPayload {
  if (!raw || typeof raw !== "object") return emptyPayload();

  const dailyActivity = zeroFillDailyActivity(raw.dailyActivity, raw.lastComputedDate);
  const activeDays = dailyActivity.filter(
    (d) => d.messageCount > 0 || d.sessionCount > 0 || d.toolCallCount > 0,
  ).length;
  const { currentStreak, longestStreak } = computeStreaks(dailyActivity);

  // Per-model token sums (input+output for the headline; +cache for the total).
  let totalTokens = 0;
  let totalTokensWithCache = 0;
  let favoriteModel: string | null = null;
  let favoriteModelTokens = -1;
  for (const [model, u] of Object.entries(raw.modelUsage ?? {})) {
    const io = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    totalTokens += io;
    totalTokensWithCache +=
      io + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    if (io > favoriteModelTokens) {
      favoriteModelTokens = io;
      favoriteModel = model;
    }
  }

  // Hour-of-day with the most sessions.
  let favoriteHour: number | null = null;
  let favoriteHourCount = -1;
  for (const [hour, count] of Object.entries(raw.hourCounts ?? {})) {
    const h = Number(hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    if (typeof count === "number" && count > favoriteHourCount) {
      favoriteHourCount = count;
      favoriteHour = h;
    }
  }

  const hasData =
    dailyActivity.length > 0 ||
    favoriteModel !== null ||
    (raw.totalSessions ?? 0) > 0 ||
    (raw.totalMessages ?? 0) > 0;

  return {
    dailyActivity,
    totalTokens,
    totalTokensWithCache,
    activeDays,
    currentStreak,
    longestStreak,
    favoriteModel,
    favoriteHour,
    firstSessionDate:
      typeof raw.firstSessionDate === "string" ? raw.firstSessionDate : null,
    totalSessions: raw.totalSessions ?? 0,
    totalMessages: raw.totalMessages ?? 0,
    hasData,
  };
}

/**
 * Read + normalize stats-cache.json. Defaults to ~/.claude/stats-cache.json;
 * tests pass a fixture path. Any read/parse failure yields the empty shape so
 * the endpoint never throws.
 */
export function readStats(filePath: string = STATS_PATH): StatsPayload {
  let raw: RawStats | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawStats;
  } catch {
    return emptyPayload();
  }
  return normalizeStats(raw);
}
