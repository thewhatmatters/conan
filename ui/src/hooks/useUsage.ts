import { useEffect, useState } from "react";

export interface UsageState {
  now: number;
  costToday: number;
  tokensToday: number;
  dailyCeilingUsd: number | null;
  pct: number | null;
  rateLimited: boolean;
  resetAt: number | null;
  hasData: boolean;
}

const EMPTY: UsageState = {
  now: 0,
  costToday: 0,
  tokensToday: 0,
  dailyCeilingUsd: null,
  pct: null,
  rateLimited: false,
  resetAt: null,
  hasData: false,
};

/**
 * Loads the Usage hero widget data from GET /api/claude/usage (US-030): cost +
 * tokens today, plus the rate-limited state and reset time. Refetches whenever
 * a new WS event arrives (via `eventSeq`) so the rate-limit state and figures
 * stay live; the resets-in countdown then ticks client-side off `resetAt`.
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
          dailyCeilingUsd:
            typeof u.dailyCeilingUsd === "number" ? u.dailyCeilingUsd : null,
          pct: typeof u.pct === "number" ? u.pct : null,
          rateLimited: u.rateLimited === true,
          resetAt: typeof u.resetAt === "number" ? u.resetAt : null,
          hasData: u.hasData === true,
        }),
      )
      .catch(() => {});
  }, [eventSeq]);

  return usage;
}
