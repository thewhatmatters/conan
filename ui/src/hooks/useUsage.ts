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
  /** Current week, Sonnet-only window (US-010); null on plans without it. */
  sevenDaySonnet: UsageWindow | null;
  status: "ok" | "warning" | "limit";
  probedAt: number;
}

/**
 * The account-global /usage windows slot (US-006/US-007): the latest rate-limit
 * windows captured by ANY session's live pty or the throwaway probe — the
 * windows describe the account, not the session that rendered them, so every
 * tab's Usage panel serves this one slot. `capturedAt` drives the "captured Xm
 * ago" freshness hint; `fromSessionId` is null for probe captures.
 */
export interface UsageWindows {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  status: "ok" | "warning" | "limit";
  capturedAt: number;
  fromSessionId: string | null;
}

/** Per-model token usage from the /usage Session block (US-010). */
export interface ModelUsage {
  model: string | null;
  modelDisplay: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The session-specific Session block of the /usage screen (US-010). */
export interface UsageSession {
  totalCostUsd: number | null;
  apiDurationMs: number | null;
  wallDurationMs: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  byModel: ModelUsage[];
}

/** One "What's contributing to your limits usage?" insight (US-007). */
export interface UsageInsight {
  headlinePct: number;
  factor: string;
  advice: string;
}

/** One row of the "Skills · % of usage" table (US-007). */
export interface UsageSkill {
  name: string;
  pct: number;
}

/**
 * The EXACT /usage capture from the active session's live pty (US-010): the
 * session-specific block + all three windows, parsed from one rendered frame.
 * null when no frame has been captured for the session — the widget then falls
 * back to the throwaway-probe windows, then the token-trend baseline.
 */
export interface LiveUsage {
  session: UsageSession | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  status: "ok" | "warning" | "limit";
  /** "What's contributing" attributions (US-007); [] when absent. */
  insights: UsageInsight[];
  /** "Skills · % of usage" rows (US-007); [] when absent. */
  skills: UsageSkill[];
  capturedAt: number;
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
  /** Live /usage capture for the active session (US-010); null → use the probe. */
  liveUsage: LiveUsage | null;
  /** Account-global windows slot (US-006/US-007); null before ANY capture. */
  usageWindows: UsageWindows | null;
  /** Which path produced planUtilization/usageWindows (US-008); null → no data yet. */
  usageSource: "oauth" | "pty-probe" | null;
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
  liveUsage: null,
  usageWindows: null,
  usageSource: null,
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
    sevenDaySonnet: parseWindow(o.sevenDaySonnet),
    status,
    probedAt: typeof o.probedAt === "number" ? o.probedAt : 0,
  };
}

/** Normalize the raw account-global usageWindows slot (US-006/US-007). */
function parseUsageWindows(p: unknown): UsageWindows | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const status =
    o.status === "warning" || o.status === "limit" ? o.status : "ok";
  return {
    fiveHour: parseWindow(o.fiveHour),
    sevenDay: parseWindow(o.sevenDay),
    sevenDaySonnet: parseWindow(o.sevenDaySonnet),
    status,
    capturedAt: typeof o.capturedAt === "number" ? o.capturedAt : 0,
    fromSessionId:
      typeof o.fromSessionId === "string" ? o.fromSessionId : null,
  };
}

/** Coerce an unknown to a finite number, or null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalize one raw per-model usage row (US-010). */
function parseModelUsage(m: unknown): ModelUsage | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  return {
    model: typeof o.model === "string" ? o.model : null,
    modelDisplay: typeof o.modelDisplay === "string" ? o.modelDisplay : null,
    inputTokens: num(o.inputTokens) ?? 0,
    outputTokens: num(o.outputTokens) ?? 0,
    cacheReadTokens: num(o.cacheReadTokens) ?? 0,
    cacheWriteTokens: num(o.cacheWriteTokens) ?? 0,
  };
}

/** Normalize the raw liveUsage payload (US-010), tolerating null/absent. */
function parseLiveUsage(p: unknown): LiveUsage | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const status =
    o.status === "warning" || o.status === "limit" ? o.status : "ok";
  let session: UsageSession | null = null;
  if (o.session && typeof o.session === "object") {
    const s = o.session as Record<string, unknown>;
    session = {
      totalCostUsd: num(s.totalCostUsd),
      apiDurationMs: num(s.apiDurationMs),
      wallDurationMs: num(s.wallDurationMs),
      linesAdded: num(s.linesAdded),
      linesRemoved: num(s.linesRemoved),
      byModel: Array.isArray(s.byModel)
        ? s.byModel.map(parseModelUsage).filter((m): m is ModelUsage => !!m)
        : [],
    };
  }
  return {
    session,
    fiveHour: parseWindow(o.fiveHour),
    sevenDay: parseWindow(o.sevenDay),
    sevenDaySonnet: parseWindow(o.sevenDaySonnet),
    status,
    insights: Array.isArray(o.insights)
      ? o.insights.map(parseInsight).filter((i): i is UsageInsight => !!i)
      : [],
    skills: Array.isArray(o.skills)
      ? o.skills.map(parseSkill).filter((s): s is UsageSkill => !!s)
      : [],
    capturedAt: num(o.capturedAt) ?? 0,
  };
}

/** Normalize one raw "What's contributing" insight (US-007). */
function parseInsight(i: unknown): UsageInsight | null {
  if (!i || typeof i !== "object") return null;
  const o = i as Record<string, unknown>;
  if (typeof o.headlinePct !== "number") return null;
  return {
    headlinePct: o.headlinePct,
    factor: typeof o.factor === "string" ? o.factor : "",
    advice: typeof o.advice === "string" ? o.advice : "",
  };
}

/** Normalize one raw "Skills · % of usage" row (US-007). */
function parseSkill(s: unknown): UsageSkill | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.pct !== "number") return null;
  return { name: o.name, pct: o.pct };
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
    liveUsage: parseLiveUsage(u.liveUsage),
    usageWindows: parseUsageWindows(u.usageWindows),
    usageSource: u.usageSource === "oauth" || u.usageSource === "pty-probe" ? u.usageSource : null,
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
 *
 * `sessionId` binds the live /usage capture (US-010) to the active session via
 * `?session=` so the Session block surfaces.
 */
export function useUsage(
  eventSeq: number | null,
  token: string | null = null,
  sessionId: string | null = null,
): { usage: UsageState } {
  const [usage, setUsage] = useState<UsageState>(EMPTY);

  const sessionQuery = sessionId
    ? `?session=${encodeURIComponent(sessionId)}`
    : "";

  // Baseline + cached scrape + live capture: refetch on every event.
  useEffect(() => {
    fetch(apiBase() + "/api/claude/usage" + sessionQuery)
      .then((r) => r.json())
      .then((u) => setUsage(normalize(u)))
      .catch(() => {});
  }, [eventSeq, sessionQuery]);

  // Lazily request ONE fresh /usage scrape when the dashboard opens (token-gated).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const sep = sessionQuery ? "&" : "?";
    fetch(apiBase() + "/api/claude/usage" + sessionQuery + sep + "probe=1", {
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
  }, [token, sessionQuery]);

  return { usage };
}
