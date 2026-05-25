import { useEffect, useState } from "react";

/** Output-token consumption over recent rolling windows (plan-usage trend). */
export interface TokensRecent {
  last5h: number;
  last7d: number;
}

export interface UsageState {
  now: number;
  /** Cost recorded today (USD) — informational only, NOT a ceiling. */
  costToday: number;
  tokensToday: number;
  tokensRecent: TokensRecent;
  rateLimited: boolean;
  resetAt: number | null;
  hasData: boolean;
}

const EMPTY: UsageState = {
  now: 0,
  costToday: 0,
  tokensToday: 0,
  tokensRecent: { last5h: 0, last7d: 0 },
  rateLimited: false,
  resetAt: null,
  hasData: false,
};

/**
 * Loads the Usage hero widget data from GET /api/claude/usage (US-004): plan-
 * usage framing — token consumption over rolling windows + a rate-limited state
 * and reset time (cost-today is informational, not a ceiling). Refetches
 * whenever a new WS event arrives (via `eventSeq`) so the figures stay live; the
 * resets-in countdown then ticks client-side off `resetAt`.
 */
export function useUsage(eventSeq: number | null): UsageState {
  const [usage, setUsage] = useState<UsageState>(EMPTY);

  useEffect(() => {
    fetch("/api/claude/usage")
      .then((r) => r.json())
      .then((u) =>
        setUsage({
          now: typeof u.now === "number" ? u.now : Date.now(),
          costToday: typeof u.costToday === "number" ? u.costToday : 0,
          tokensToday: typeof u.tokensToday === "number" ? u.tokensToday : 0,
          tokensRecent: {
            last5h:
              typeof u.tokensRecent?.last5h === "number"
                ? u.tokensRecent.last5h
                : 0,
            last7d:
              typeof u.tokensRecent?.last7d === "number"
                ? u.tokensRecent.last7d
                : 0,
          },
          rateLimited: u.rateLimited === true,
          resetAt: typeof u.resetAt === "number" ? u.resetAt : null,
          hasData: u.hasData === true,
        }),
      )
      .catch(() => {});
  }, [eventSeq]);

  return usage;
}
