import { useEffect, useState } from "react";
import type { Session } from "../hooks/useSessions.ts";
import type { UsageState, UsageWindow } from "../hooks/useUsage.ts";
import type { ContextCategory, WidgetData } from "../hooks/useWidgets.ts";
import StatCard from "./StatCard.tsx";

/* ---- widget cells -------------------------------------------------------- */
//
// US-004: the HUD ships exactly two widget cells — Context (session) and Usage
// (global) — each rendered as its own DevTools-style HUD tab. They are exported
// individually (no carousel, picker, or scope plumbing) and consumed by Hud.tsx.

/**
 * Per-session context-window usage (US-013). Prefers the latest assistant turn's
 * usage from the transcript (`data.context`: input + cache-read + cache-creation
 * tokens, which is what fills the window for the next turn), with the window size
 * derived from that message's model. Falls back to the session row's stored
 * context_tokens when no fresh transcript usage is available, and to "—" when
 * there's nothing at all. Themed with semantic tokens only.
 */
export function ContextWidget({
  session,
  data,
}: {
  session: Session | null;
  data: WidgetData | null;
}) {
  const live = data?.context ?? null;
  const ctxTokens = live?.used ?? session?.context_tokens ?? null;
  const ctxWindow = contextWindowFor(live?.model ?? session?.model ?? null);
  const ctxPct =
    ctxTokens != null ? Math.min(100, (ctxTokens / ctxWindow) * 100) : null;
  const sub = session ? (live ? "active · live" : "active session") : "no session";
  const breakdown = data?.contextBreakdown ?? null;
  return (
    <StatCard label="Context" sub={sub}>
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
      {breakdown && breakdown.categories.length > 0 && (
        <ContextBreakdownBar breakdown={breakdown} />
      )}
    </StatCard>
  );
}

/** Per-category chart color for the context breakdown segments (US-007). */
const CTX_CAT_COLOR: Record<ContextCategory["key"], string> = {
  system: "bg-chart-4",
  tools: "bg-chart-2",
  mcp: "bg-chart-3",
  memory: "bg-chart-1",
  skills: "bg-chart-5",
  messages: "bg-primary",
};

/**
 * Stacked mini-bar + legend approximating where the context window is going
 * (US-007), reconstructed from disk by the backend (memory/skills/MCP sizes +
 * messages as the remainder of the real total). Segments are sized by share of
 * the approximated total so they sum to the bar; the legend lists each category
 * with its token estimate. Semantic/chart tokens only.
 */
function ContextBreakdownBar({
  breakdown,
}: {
  breakdown: NonNullable<WidgetData["contextBreakdown"]>;
}) {
  const total = breakdown.approxTotal || 1;
  return (
    <div className="mt-2">
      <span className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {breakdown.categories.map((c) => (
          <span
            key={c.key}
            className={CTX_CAT_COLOR[c.key]}
            style={{ width: `${(c.tokens / total) * 100}%` }}
            title={`${c.label}: ≈${fmtTokens(c.tokens)} tokens`}
          />
        ))}
      </span>
      <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
        {breakdown.categories.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1">
            <span className={"size-1.5 rounded-full " + CTX_CAT_COLOR[c.key]} />
            {c.label} {fmtTokens(c.tokens)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Usage monitor (US-004/US-005/US-025). When a fresh `/usage` scrape exists
 * (`planUtilization`, US-005) it shows the REAL plan utilization: the 5-hour and
 * 7-day "% used" with a per-window reset countdown and a warning/limit posture.
 * Otherwise it falls back to the token-trend baseline (recent token consumption
 * + a rate-limited state and reset countdown derived from api_retry events) and
 * marks itself an approximation via the "≈ approx" tag. It is never blank: with
 * no data at all it shows "—". The countdowns tick client-side off `resetAt`.
 */
export function UsageWidget({ usage }: { usage: UsageState }) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Prefer the real scrape (US-005) when it carries at least one parsed window.
  const plan = usage.planUtilization;
  const hasPlan = !!plan && (!!plan.fiveHour || !!plan.sevenDay);
  if (hasPlan && plan) return <PlanUsage plan={plan} tick={tick} />;

  // --- baseline (US-004): token-trend approximation -------------------------
  const remaining =
    usage.resetAt != null ? Math.max(0, usage.resetAt - tick) : null;
  const resetLabel =
    remaining != null
      ? remaining > 0
        ? `resets in ${fmtDuration(remaining)}`
        : "reset due"
      : null;

  let headline: string;
  if (!usage.hasData) headline = "—";
  else if (usage.tokensRecent.last5h > 0)
    headline = `${fmtTokens(usage.tokensRecent.last5h)} tok`;
  else if (usage.tokensToday > 0) headline = `${fmtTokens(usage.tokensToday)} tok`;
  else headline = "—";

  return (
    <StatCard label="Usage" sub={usage.rateLimited ? "rate limited" : "last 5h"}>
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
        <ApproxTag />
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {resetLabel
          ? resetLabel
          : usage.hasData
            ? usage.tokensRecent.last7d > 0
              ? `${fmtTokens(usage.tokensRecent.last7d)} tok · 7d`
              : usage.costToday > 0
                ? `$${usage.costToday.toFixed(2)} today`
                : "active"
            : "no usage data"}
      </div>
    </StatCard>
  );
}

/** Posture → text color for the headline + status chip. */
const STATUS_COLOR: Record<"ok" | "warning" | "limit", string> = {
  ok: "text-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  limit: "text-destructive",
};

/**
 * The REAL plan-utilization face of the Usage widget (US-025): the 5-hour and
 * 7-day windows' "% used" + per-window reset countdown, headlined by the worst
 * window and tinted by the scrape's posture. The countdown ticks off `tick`.
 */
function PlanUsage({
  plan,
  tick,
}: {
  plan: NonNullable<UsageState["planUtilization"]>;
  tick: number;
}) {
  // Headline = the window closest to its limit (the binding constraint).
  const worst =
    Math.max(
      plan.fiveHour?.utilizationPct ?? -1,
      plan.sevenDay?.utilizationPct ?? -1,
    ) | 0;
  const statusLabel =
    plan.status === "limit"
      ? "Limit"
      : plan.status === "warning"
        ? "High"
        : null;

  return (
    <StatCard label="Usage" sub="plan · live">
      <div className="flex items-center gap-2">
        <span className={"text-xl font-semibold " + STATUS_COLOR[plan.status]}>
          {worst}%
        </span>
        {statusLabel && (
          <span
            className={
              "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
              (plan.status === "limit"
                ? "bg-destructive/15 text-destructive"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400")
            }
          >
            {statusLabel}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        <PlanWindowRow label="5h" win={plan.fiveHour} tick={tick} />
        <PlanWindowRow label="7d" win={plan.sevenDay} tick={tick} />
      </div>
    </StatCard>
  );
}

/** One window row: label, mini bar + %, and a reset countdown. */
function PlanWindowRow({
  label,
  win,
  tick,
}: {
  label: string;
  win: UsageWindow | null;
  tick: number;
}) {
  if (!win) return null;
  const pct = Math.max(0, Math.min(100, win.utilizationPct));
  const remaining = win.resetAt != null ? Math.max(0, win.resetAt - tick) : null;
  const barColor =
    win.utilizationPct >= 100
      ? "bg-destructive"
      : win.utilizationPct >= 80
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-5 shrink-0 text-muted-foreground">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={"block h-full rounded-full " + barColor}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right tabular-nums text-foreground">
        {win.utilizationPct}%
      </span>
      <span className="w-20 shrink-0 truncate text-right text-muted-foreground">
        {remaining != null
          ? remaining > 0
            ? fmtDuration(remaining)
            : "due"
          : ""}
      </span>
    </div>
  );
}

/**
 * The "≈ approx" marker for the Usage widget: a hover tooltip making clear that
 * the figures approximate plan usage from our own token counts — the true live
 * plan % lives in response headers Conan can't read. Group-hover panel (no
 * tooltip dependency), semantic tokens only, themed for light + dark.
 */
function ApproxTag() {
  return (
    <span className="group/approx relative ml-auto inline-block">
      <span className="cursor-help rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        ≈ approx
      </span>
      <span className="pointer-events-none absolute right-0 top-full z-20 mt-1 hidden w-52 rounded-md border border-border bg-card p-2 text-left text-[11px] leading-snug text-muted-foreground shadow-md group-hover/approx:block">
        Approximation from our own token counts. The real plan % lives in the
        Claude process's rate-limit response headers, which Conan can't read.
      </span>
    </span>
  );
}

/* ---- shared bits --------------------------------------------------------- */

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
