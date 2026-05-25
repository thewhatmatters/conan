import { useEffect, useState } from "react";
import type { Session } from "../hooks/useSessions.ts";
import type { SkillsState } from "../hooks/useSkills.ts";
import type { UsageState } from "../hooks/useUsage.ts";
import StatCard from "./StatCard.tsx";

interface HeroWidgetsProps {
  sessions: Session[];
  /** The session the Context/Skills widgets describe (running > newest). */
  activeSession: Session | null;
  skills: SkillsState;
  /** Usage / rate-limit state for the Usage widget (US-030). */
  usage: UsageState;
}

/**
 * The hero metrics widget row (US-010): a row of stat cards at the top of the
 * /claude main area — Context, Skills, Cost today, Active sessions. Fed by the
 * live session grid + skills endpoint, so it updates as WS events arrive.
 * Uses the two-tier StatCard pattern and semantic tokens only.
 */
export default function HeroWidgets({
  sessions,
  activeSession,
  skills,
  usage,
}: HeroWidgetsProps) {
  // Context window: tokens in vs. the model's window, for the active session.
  const ctxTokens = activeSession?.context_tokens ?? null;
  const ctxWindow = contextWindowFor(activeSession?.model ?? null);
  const ctxPct =
    ctxTokens != null ? Math.min(100, (ctxTokens / ctxWindow) * 100) : null;

  // Cost today: aggregate total_cost_usd across sessions active today.
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const costToday = sessions
    .filter((s) => s.last_activity >= startOfToday)
    .reduce((sum, s) => sum + (s.total_cost_usd || 0), 0);

  // Active-sessions breakdown.
  const running = sessions.filter((s) => s.status === "running").length;
  const idle = sessions.filter((s) => s.status === "idle").length;
  const error = sessions.filter(
    (s) => s.status !== "running" && s.status !== "idle",
  ).length;

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Context" sub={activeSession ? "active session" : "no session"}>
        <div className="flex items-center gap-3">
          <Ring pct={ctxPct} />
          <div className="min-w-0">
            <div className="text-xl font-semibold text-foreground">
              {ctxPct != null ? `${Math.round(ctxPct)}%` : "—"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {ctxTokens != null
                ? `${fmtTokens(ctxTokens)} / ${fmtTokens(ctxWindow)}`
                : "no usage yet"}
            </div>
          </div>
        </div>
      </StatCard>

      <StatCard label="Skills" sub="available · loaded">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-semibold text-foreground">
            {skills.available}
          </span>
          <span className="text-sm text-muted-foreground">
            · {skills.loaded != null ? skills.loaded : "—"} loaded
          </span>
        </div>
      </StatCard>

      <StatCard label="Cost today" sub="across sessions">
        <div className="text-xl font-semibold text-foreground">
          {costToday > 0 ? `$${costToday.toFixed(2)}` : "$0.00"}
        </div>
      </StatCard>

      <StatCard label="Active sessions" sub="running · idle · error">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold text-foreground">
            {sessions.length}
          </span>
          <span className="flex items-center gap-2 text-[11px]">
            <Pip className="bg-primary" n={running} />
            <Pip className="bg-muted-foreground/40" n={idle} />
            <Pip className="bg-destructive" n={error} />
          </span>
        </div>
      </StatCard>

      <UsageWidget usage={usage} />
    </section>
  );
}

/**
 * Usage monitor (US-030): current usage today (cost / % of the daily ceiling)
 * plus a "resets in …" countdown, and a distinct rate-limited state derived
 * from api_retry events. Ticks the countdown client-side off `resetAt` and
 * degrades to "—" when no usage/reset data is available.
 */
function UsageWidget({ usage }: { usage: UsageState }) {
  // Tick once a second so the countdown advances without a refetch.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining =
    usage.resetAt != null ? Math.max(0, usage.resetAt - tick) : null;
  const resetLabel =
    remaining != null
      ? remaining > 0
        ? `resets in ${fmtDuration(remaining)}`
        : "reset due"
      : null;

  // The headline value: percent of the daily ceiling when one is set, else the
  // dollar cost, else a dash when we have nothing to show.
  let headline: string;
  if (!usage.hasData) headline = "—";
  else if (usage.pct != null) headline = `${Math.round(usage.pct)}%`;
  else if (usage.costToday > 0) headline = `$${usage.costToday.toFixed(2)}`;
  else headline = "—";

  return (
    <StatCard
      label="Usage"
      sub={usage.rateLimited ? "rate limited" : "today"}
    >
      <div className="flex items-center gap-2">
        <span
          className={
            "text-xl font-semibold " +
            (usage.rateLimited ? "text-destructive" : "text-foreground")
          }
        >
          {headline}
        </span>
        {usage.rateLimited && (
          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
            Limited
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {resetLabel
          ? resetLabel
          : usage.hasData
            ? usage.tokensToday > 0
              ? `${fmtTokens(usage.tokensToday)} tok · $${usage.costToday.toFixed(2)}`
              : `$${usage.costToday.toFixed(2)} today`
            : "no usage data"}
      </div>
    </StatCard>
  );
}

/** Compact "1h 02m" / "12m 30s" / "45s" duration for the reset countdown. */
function fmtDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** A small SVG progress ring for the context gauge (semantic tokens only). */
function Ring({ pct }: { pct: number | null }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const filled = pct != null ? (pct / 100) * c : 0;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="shrink-0">
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        strokeWidth="4"
        className="stroke-muted-foreground/20"
      />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c}`}
        transform="rotate(-90 18 18)"
        className={pct != null && pct >= 80 ? "stroke-destructive" : "stroke-primary"}
      />
    </svg>
  );
}

/** A colored count pip; rendered muted when its count is zero. */
function Pip({ className, n }: { className: string; n: number }) {
  return (
    <span className={"inline-flex items-center gap-1 " + (n ? "" : "opacity-40")}>
      <span className={"size-2 rounded-full " + className} />
      <span className="text-foreground">{n}</span>
    </span>
  );
}

/**
 * Best-effort context-window size for a model slug. Claude's default window is
 * 200k; the 1M-context variants carry a "1m"/"[1m]" marker in the slug.
 */
function contextWindowFor(model: string | null): number {
  if (model && /1m/i.test(model)) return 1_000_000;
  return 200_000;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}
