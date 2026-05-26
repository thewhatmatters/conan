import { useEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions.ts";
import type { SkillsState } from "../hooks/useSkills.ts";
import type { UsageState } from "../hooks/useUsage.ts";
import type { McpState } from "../hooks/useMcp.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import {
  WIDGET_KEYS,
  WIDGET_LABELS,
  type WidgetKey,
} from "../hooks/useWidgetPrefs.ts";
import StatCard from "./StatCard.tsx";

interface WidgetsProps {
  sessions: Session[];
  /** The session the per-session widgets describe (running > newest). */
  activeSession: Session | null;
  skills: SkillsState;
  usage: UsageState;
  /** MCP server status (US-011): inferred connected count + names + needs-auth. */
  mcp: McpState;
  /** Per-session widget data (Git); null until at least one widget is on. */
  data: WidgetData | null;
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
}

/**
 * The picker-fronted hero widget area (US-010). A "Widgets ▾" menu chooses which
 * cards show; the grid maxes at five columns so it never grows into an
 * overflowing row. Each enabled widget renders in `WIDGET_KEYS` order. The
 * Plugins, API-retry, and Top-tools widgets were removed; the remaining/new
 * widgets — Context, Active sessions, Skills, Cost, MCP, Model & idle, Git,
 * Usage, Stats — all slot into this one structure.
 */
export default function Widgets({
  sessions,
  activeSession,
  skills,
  usage,
  mcp,
  data,
  enabled,
  toggle,
}: WidgetsProps) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Widgets
        </span>
        <WidgetPicker enabled={enabled} toggle={toggle} />
      </div>

      {enabled.size === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No widgets shown. Use{" "}
          <span className="font-medium text-foreground">Widgets ▾</span> to
          surface Context, sessions, MCP, model, git, usage, or stats.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {WIDGET_KEYS.filter((key) => enabled.has(key)).map((key) => (
            <WidgetCell
              key={key}
              k={key}
              sessions={sessions}
              activeSession={activeSession}
              skills={skills}
              usage={usage}
              mcp={mcp}
              data={data}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Render the right card for one widget key. */
function WidgetCell({
  k,
  sessions,
  activeSession,
  skills,
  usage,
  mcp,
  data,
}: {
  k: WidgetKey;
  sessions: Session[];
  activeSession: Session | null;
  skills: SkillsState;
  usage: UsageState;
  mcp: McpState;
  data: WidgetData | null;
}) {
  switch (k) {
    case "context":
      return <ContextWidget session={activeSession} data={data} />;
    case "sessions":
      return <SessionsWidget sessions={sessions} />;
    case "skills":
      return <SkillsWidget skills={skills} />;
    case "cost":
      return <CostWidget sessions={sessions} />;
    case "mcp":
      return <McpWidget mcp={mcp} />;
    case "model":
      return <ModelIdleWidget session={activeSession} />;
    case "git":
      return <GitWidget data={data} />;
    case "usage":
      return <UsageWidget usage={usage} />;
    case "stats":
      return <StatsWidget />;
  }
}

/** The "Widgets ▾" dropdown: a checkbox per available widget. */
function WidgetPicker({
  enabled,
  toggle,
}: {
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        Widgets ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-border bg-card p-1 shadow-md">
          {WIDGET_KEYS.map((key) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-foreground hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={enabled.has(key)}
                onChange={() => toggle(key)}
                className="accent-primary"
              />
              {WIDGET_LABELS[key]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- widget cells -------------------------------------------------------- */

/**
 * Per-session context-window usage (US-013). Prefers the latest assistant turn's
 * usage from the transcript (`data.context`: input + cache-read + cache-creation
 * tokens, which is what fills the window for the next turn), with the window size
 * derived from that message's model. Falls back to the session row's stored
 * context_tokens when no fresh transcript usage is available, and to "—" when
 * there's nothing at all. Themed with semantic tokens only.
 */
function ContextWidget({
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
    </StatCard>
  );
}

function SessionsWidget({ sessions }: { sessions: Session[] }) {
  const running = sessions.filter((s) => s.status === "running").length;
  const idle = sessions.filter((s) => s.status === "idle").length;
  const error = sessions.filter(
    (s) => s.status !== "running" && s.status !== "idle",
  ).length;
  return (
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
  );
}

function SkillsWidget({ skills }: { skills: SkillsState }) {
  return (
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
  );
}

function CostWidget({ sessions }: { sessions: Session[] }) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const costToday = sessions
    .filter((s) => s.last_activity >= startOfToday)
    .reduce((sum, s) => sum + (s.total_cost_usd || 0), 0);
  return (
    <StatCard label="Cost today" sub="across sessions">
      <div className="text-xl font-semibold text-foreground">
        {costToday > 0 ? `$${costToday.toFixed(2)}` : "$0.00"}
      </div>
    </StatCard>
  );
}

/**
 * MCP servers widget (US-011). Shows the inferred connected count from
 * /api/claude/mcp (US-003 — config-derived, enriched by a live session's real
 * statuses) over the total known. Hovering reveals a tooltip listing every
 * server by name with its status, flagging any that need (re)auth. No tooltip
 * dependency: a group-hover panel, themed with semantic tokens.
 */
function McpWidget({ mcp }: { mcp: McpState }) {
  const sub = mcp.fromLiveSession ? "connected · live" : "connected · total";
  return (
    <StatCard label="MCP servers" sub={sub}>
      {!mcp.hasData ? (
        <Dash />
      ) : (
        <div className="group/mcp relative inline-block">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold text-foreground">
              {mcp.connectedCount}
            </span>
            <span className="text-sm text-muted-foreground">
              · {mcp.servers.length}
            </span>
            {mcp.needsAuthCount > 0 && (
              <span className="ml-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
                {mcp.needsAuthCount} auth
              </span>
            )}
          </div>
          <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-44 rounded-md border border-border bg-card p-2 text-left shadow-md group-hover/mcp:block">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              MCP servers
            </div>
            <ul className="space-y-1">
              {mcp.servers.map((s) => (
                <li
                  key={s.name}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="truncate font-mono text-foreground">
                    {s.name}
                  </span>
                  <McpStatusTag status={s.status} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </StatCard>
  );
}

/** A small per-server status pill for the MCP tooltip. */
function McpStatusTag({ status }: { status: McpServerStatusValue }) {
  if (status === "needs-auth") {
    return (
      <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-500">
        needs auth
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="shrink-0 rounded bg-destructive/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-destructive">
        failed
      </span>
    );
  }
  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className="size-1.5 rounded-full bg-primary" />
      connected
    </span>
  );
}

type McpServerStatusValue = McpState["servers"][number]["status"];

function ModelIdleWidget({ session }: { session: Session | null }) {
  const model = session?.model ?? null;
  const idle = session ? session.status !== "running" : false;
  return (
    <StatCard label="Model & idle" sub={session ? session.status : "no session"}>
      {session == null ? (
        <Dash />
      ) : (
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {model ?? "unknown"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {idle ? `idle ${sinceLabel(session.last_activity)}` : "active now"}
          </div>
        </div>
      )}
    </StatCard>
  );
}

function GitWidget({ data }: { data: WidgetData | null }) {
  const git = data?.git;
  return (
    <StatCard label="Git" sub="branch · dirty">
      {git == null ? (
        <Dash />
      ) : !git.available ? (
        <span className="text-sm text-muted-foreground">not a repo</span>
      ) : (
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold text-foreground">
            {git.branch}
          </div>
          <div
            className={
              "text-[11px] " +
              (git.dirty > 0 ? "text-amber-500" : "text-muted-foreground")
            }
          >
            {git.dirty > 0 ? `${git.dirty} dirty` : "clean"}
          </div>
        </div>
      )}
    </StatCard>
  );
}

/**
 * Usage monitor (US-004): plan-usage framing for a token-based plan — recent
 * token consumption (last 5h) plus a "resets in …" countdown, and a distinct
 * rate-limited state derived from api_retry events. Ticks the countdown
 * client-side off `resetAt` and degrades to "—" when no usage data is available.
 */
function UsageWidget({ usage }: { usage: UsageState }) {
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

/** Placeholder until the contribution-heatmap stats widget lands (US-015). */
function StatsWidget() {
  return (
    <StatCard label="Stats" sub="activity & streaks">
      <span className="text-sm text-muted-foreground">coming soon</span>
    </StatCard>
  );
}

/* ---- shared bits --------------------------------------------------------- */

function Dash() {
  return <span className="text-xl font-semibold text-muted-foreground">—</span>;
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

/** Compact "time since" label for the model/idle widget. */
function sinceLabel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
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
