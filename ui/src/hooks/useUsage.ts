import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Output-token consumption over recent rolling windows (plan-usage trend). */
export interface TokensRecent {
  last5h: number;
  last7d: number;
}

/** One real /usage window (5-hour block or 7-day): % used + when it resets. */
export interface UsageWindow {
  utilizationPct: number;
  resetAt: number | null;
}

/**
 * The REAL plan utilization scraped from Claude Code's `/usage` TUI (US-005),
 * when a fresh probe exists. `null` when no scrape is available — the widget
 * then falls back to the token-trend baseline below.
 */
export interface PlanUtilization {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  status: "ok" | "warning" | "limit";
  probedAt: number;
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
  /** Real /usage scrape (US-005) when fresh; null → fall back to the baseline. */
  planUtilization: PlanUtilization | null;
}

const EMPTY: UsageState = {
  now: 0,
  costToday: 0,
  tokensToday: 0,
  tokensRecent: { last5h: 0, last7d: 0 },
  rateLimited: false,
  resetAt: null,
  hasData: false,
  planUtilization: null,
};

/** Normalize one raw /usage window into a typed UsageWindow (or null). */
function parseWindow(w: unknown): UsageWindow | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  if (typeof o.utilizationPct !== "number") return null;
  return {
    utilizationPct: o.utilizationPct,
    resetAt: typeof o.resetAt === "number" ? o.resetAt : null,
  };
}

/** Normalize the raw planUtilization payload (US-005), tolerating null/absent. */
function parsePlanUtilization(p: unknown): PlanUtilization | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const status =
    o.status === "warning" || o.status === "limit" ? o.status : "ok";
  return {
    fiveHour: parseWindow(o.fiveHour),
    sevenDay: parseWindow(o.sevenDay),
    status,
    probedAt: typeof o.probedAt === "number" ? o.probedAt : 0,
  };
}

function normalize(u: Record<string, unknown>): UsageState {
  const tr = (u.tokensRecent ?? {}) as Record<string, unknown>;
  return {
    now: typeof u.now === "number" ? u.now : Date.now(),
    costToday: typeof u.costToday === "number" ? u.costToday : 0,
    tokensToday: typeof u.tokensToday === "number" ? u.tokensToday : 0,
    tokensRecent: {
      last5h: typeof tr.last5h === "number" ? tr.last5h : 0,
      last7d: typeof tr.last7d === "number" ? tr.last7d : 0,
    },
    rateLimited: u.rateLimited === true,
    resetAt: typeof u.resetAt === "number" ? u.resetAt : null,
    hasData: u.hasData === true,
    planUtilization: parsePlanUtilization(u.planUtilization),
  };
}

/**
 * Loads the Usage hero widget data from GET /api/claude/usage (US-004/US-005):
 * the token-trend baseline (consumption over rolling windows + a rate-limited
 * state and reset time) plus the REAL plan utilization scraped from `/usage`
 * (`planUtilization`, US-005) when a fresh probe exists. Refetches whenever a
 * new WS event arrives (via `eventSeq`) so the figures stay live; the resets-in
 * countdown then ticks client-side off `resetAt`.
 *
 * Once on mount — and only when a token is available — it asks the gateway for a
 * fresh scrape via `?probe=1` (token-gated, since the probe spawns a short-lived
 * `claude` process). The probe is bounded and never throws on the backend, so a
 * failure just leaves `planUtilization` null and the widget falls back to the
 * baseline; it is NOT repeated on every event (no tight billed-probe loop).
 */
export function useUsage(
  eventSeq: number | null,
  token: string | null = null,
): UsageState {
  const [usage, setUsage] = useState<UsageState>(EMPTY);

  // Baseline + cached scrape: refetch on every event so the figures stay live.
  useEffect(() => {
    fetch(apiBase() + "/api/claude/usage")
      .then((r) => r.json())
      .then((u) => setUsage(normalize(u)))
      .catch(() => {});
  }, [eventSeq]);

  // Lazily request ONE fresh /usage scrape when the dashboard opens (token-gated).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiBase() + "/api/claude/usage?probe=1", {
      headers: { "x-conan-token": token },
    })
      .then((r) => r.json())
      .then((u) => {
        if (!cancelled) setUsage(normalize(u));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  return usage;
}
