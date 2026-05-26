import { useEffect, useState } from "react";

/** One day of activity (after the backend's zero-fill). Mirrors DailyActivity. */
export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

/** Normalized stats payload from GET /api/claude/stats (US-002). */
export interface StatsState {
  dailyActivity: DailyActivity[];
  totalTokens: number;
  totalTokensWithCache: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  favoriteModel: string | null;
  favoriteHour: number | null;
  firstSessionDate: string | null;
  totalSessions: number;
  totalMessages: number;
  hasData: boolean;
}

const EMPTY: StatsState = {
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

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Loads the Stats / contribution-heatmap data from GET /api/claude/stats
 * (US-002/US-015): a contiguous day calendar plus computed headline stats
 * (total tokens, active days, streaks, favorite model/hour). Refetches whenever
 * a new WS event arrives (via `eventSeq`) so the figures track live activity.
 */
export function useStats(eventSeq: number | null): StatsState {
  const [stats, setStats] = useState<StatsState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/stats")
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        setStats({
          dailyActivity: Array.isArray(s.dailyActivity)
            ? s.dailyActivity.map((d: Record<string, unknown>) => ({
                date: typeof d.date === "string" ? d.date : "",
                messageCount: num(d.messageCount),
                sessionCount: num(d.sessionCount),
                toolCallCount: num(d.toolCallCount),
              }))
            : [],
          totalTokens: num(s.totalTokens),
          totalTokensWithCache: num(s.totalTokensWithCache),
          activeDays: num(s.activeDays),
          currentStreak: num(s.currentStreak),
          longestStreak: num(s.longestStreak),
          favoriteModel:
            typeof s.favoriteModel === "string" ? s.favoriteModel : null,
          favoriteHour:
            typeof s.favoriteHour === "number" ? s.favoriteHour : null,
          firstSessionDate:
            typeof s.firstSessionDate === "string" ? s.firstSessionDate : null,
          totalSessions: num(s.totalSessions),
          totalMessages: num(s.totalMessages),
          hasData: s.hasData === true,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [eventSeq]);

  return stats;
}
