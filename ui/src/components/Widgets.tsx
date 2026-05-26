import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import type { Session } from "../hooks/useSessions.ts";
import type { SkillsState } from "../hooks/useSkills.ts";
import type { UsageState, UsageWindow } from "../hooks/useUsage.ts";
import type { McpState } from "../hooks/useMcp.ts";
import type { StatsState } from "../hooks/useStats.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import type { CwdGit } from "../hooks/useCwdGit.ts";
import type { ProjectMetrics } from "../hooks/useProjectMetrics.ts";
import {
  WIDGET_KEYS,
  WIDGET_LABELS,
  WIDGET_SCOPE,
  type WidgetKey,
  type WidgetScope,
} from "../hooks/useWidgetPrefs.ts";
import StatCard from "./StatCard.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";

interface WidgetsProps {
  sessions: Session[];
  /** The session the session-scoped widgets describe — the timeline ▾ pick (US-019). */
  activeSession: Session | null;
  skills: SkillsState;
  usage: UsageState;
  /** MCP server status (US-011): inferred connected count + names + needs-auth. */
  mcp: McpState;
  /** Claude Code usage rollup (US-015): heatmap + headline stats. */
  stats: StatsState;
  /** Per-session widget data (Context); null until at least one widget is on. */
  data: WidgetData | null;
  /** cwd-scoped git status for the active working directory (US-019). */
  git: CwdGit | null;
  /** cwd-scoped last-session metrics for the active project (US-026). */
  metrics: ProjectMetrics | null;
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
}

/** The widget row gap (Tailwind `gap-3` = 0.75rem); shared by the slot-width math. */
const ROW_GAP = "0.75rem";

/**
 * Per-widget slot span. The viewport fits ~4 single-slot widgets at a time; the
 * Stats heatmap is wide so it claims two slots. Width is computed off the
 * container so exactly four single slots fill the visible row, with the rest
 * reachable by horizontal scroll.
 */
const WIDGET_SPAN: Partial<Record<WidgetKey, number>> = { stats: 2 };

/** CSS width for a widget occupying `span` of the 4-up slots (accounting for gaps). */
function slotWidth(span: number): string {
  // single slot = (100% - 3 gaps) / 4; a span adds (span-1) inner gaps back.
  return `calc(${span} * (100% - 3 * ${ROW_GAP}) / 4 + ${span - 1} * ${ROW_GAP})`;
}

/**
 * The hero widget area (US-018). A settings cog beside the "Widgets" heading
 * opens the show/hide picker; enabled widgets render in a single horizontal row
 * that overflows (≈4 visible at once) and is paged by left/right chevrons. The
 * chevrons appear/enable only when there's content to scroll to in that
 * direction. Each enabled widget renders in `WIDGET_KEYS` order; Stats spans two
 * slots for its heatmap.
 */
export default function Widgets({
  sessions,
  activeSession,
  skills,
  usage,
  mcp,
  stats,
  data,
  git,
  metrics,
  enabled,
  toggle,
}: WidgetsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < maxScroll - 1);
  }, []);

  // Recompute scroll affordances when the enabled set changes or on resize.
  useLayoutEffect(() => {
    recompute();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute, enabled]);

  const page = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    // Advance by ~one viewport-worth (a little less so context carries over).
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  const keys = WIDGET_KEYS.filter((key) => enabled.has(key));

  return (
    // US-020: pin the widget area while the timeline scrolls beneath it. Sticky
    // within the scrolling <main>; `top-0` clamps the row's opaque background
    // flush to the scrollport top (the header lives outside the scroll container,
    // so its offset is respected for free). `-mx-6 px-6` bleeds bg-background
    // full-width over <main>'s p-6 so scrolled content can't peek past the row's
    // edges; the high z-index keeps the row (and its tooltips/chevrons) above the
    // timeline. No negative top margin — that would leave a transparent band the
    // scrolled timeline shows through.
    <section className="sticky top-0 z-20 -mx-6 bg-background px-6 pb-3 pt-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Widgets
        </span>
        <WidgetPicker enabled={enabled} toggle={toggle} />
      </div>

      {keys.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No widgets shown. Use the{" "}
          <span className="font-medium text-foreground">settings cog</span> to
          surface Context, sessions, MCP, model, git, usage, or stats.
        </p>
      ) : (
        <div className="relative">
          {canLeft && (
            <ChevronButton side="left" onClick={() => page(-1)} />
          )}
          <div
            ref={scrollRef}
            onScroll={recompute}
            className="flex gap-3 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {keys.map((key) => (
              <div
                key={key}
                className="shrink-0"
                style={{ width: slotWidth(WIDGET_SPAN[key] ?? 1) }}
              >
                <WidgetCell
                  k={key}
                  sessions={sessions}
                  activeSession={activeSession}
                  skills={skills}
                  usage={usage}
                  mcp={mcp}
                  stats={stats}
                  data={data}
                  git={git}
                  metrics={metrics}
                />
              </div>
            ))}
          </div>
          {canRight && (
            <ChevronButton side="right" onClick={() => page(1)} />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A floating chevron over the widget row's left/right edge. Only mounted when
 * there's something to scroll to in that direction (US-018). Uses the shadcn
 * Button (outline) and semantic tokens so it reads in light + dark.
 */
function ChevronButton({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onClick}
      aria-label={side === "left" ? "Scroll widgets left" : "Scroll widgets right"}
      className={
        "absolute top-1/2 z-10 size-7 -translate-y-1/2 rounded-full shadow-md " +
        (side === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2")
      }
    >
      <Icon className="size-4" />
    </Button>
  );
}

/** Render the right card for one widget key, tagged with its scope (US-019). */
function WidgetCell({
  k,
  sessions,
  activeSession,
  skills,
  usage,
  mcp,
  stats,
  data,
  git,
  metrics,
}: {
  k: WidgetKey;
  sessions: Session[];
  activeSession: Session | null;
  skills: SkillsState;
  usage: UsageState;
  mcp: McpState;
  stats: StatsState;
  data: WidgetData | null;
  git: CwdGit | null;
  metrics: ProjectMetrics | null;
}) {
  const scope = WIDGET_SCOPE[k];
  switch (k) {
    case "context":
      return <ContextWidget session={activeSession} data={data} scope={scope} />;
    case "sessions":
      return <SessionsWidget sessions={sessions} scope={scope} />;
    case "skills":
      return <SkillsWidget skills={skills} scope={scope} />;
    case "mcp":
      return <McpWidget mcp={mcp} scope={scope} />;
    case "model":
      return <ModelIdleWidget session={activeSession} scope={scope} />;
    case "git":
      return <GitWidget git={git} scope={scope} />;
    case "metrics":
      return <MetricsWidget metrics={metrics} scope={scope} />;
    case "usage":
      return <UsageWidget usage={usage} scope={scope} />;
    case "stats":
      return <StatsWidget stats={stats} scope={scope} />;
  }
}

/**
 * The widget show/hide picker (US-018): a settings cog that opens a shadcn
 * dropdown with one checkbox per available widget. Replaces the v2 "Widgets ▾"
 * text dropdown. `onSelect`-preventDefault keeps the menu open while toggling
 * several widgets in a row.
 */
function WidgetPicker({
  enabled,
  toggle,
}: {
  enabled: Set<WidgetKey>;
  toggle: (key: WidgetKey) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Configure widgets"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
      >
        <Settings2 className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Show widgets</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {WIDGET_KEYS.map((key) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={enabled.has(key)}
            onCheckedChange={() => toggle(key)}
            onSelect={(e) => e.preventDefault()}
          >
            {WIDGET_LABELS[key]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  scope,
}: {
  session: Session | null;
  data: WidgetData | null;
  scope: WidgetScope;
}) {
  const live = data?.context ?? null;
  const ctxTokens = live?.used ?? session?.context_tokens ?? null;
  const ctxWindow = contextWindowFor(live?.model ?? session?.model ?? null);
  const ctxPct =
    ctxTokens != null ? Math.min(100, (ctxTokens / ctxWindow) * 100) : null;
  const sub = session ? (live ? "active · live" : "active session") : "no session";
  return (
    <StatCard label="Context" sub={sub} scope={scope}>
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

function SessionsWidget({
  sessions,
  scope,
}: {
  sessions: Session[];
  scope: WidgetScope;
}) {
  const running = sessions.filter((s) => s.status === "running").length;
  const idle = sessions.filter((s) => s.status === "idle").length;
  const error = sessions.filter(
    (s) => s.status !== "running" && s.status !== "idle",
  ).length;
  return (
    <StatCard label="Active sessions" sub="running · idle · error" scope={scope}>
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

function SkillsWidget({
  skills,
  scope,
}: {
  skills: SkillsState;
  scope: WidgetScope;
}) {
  return (
    <StatCard label="Skills" sub="available · loaded" scope={scope}>
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

/**
 * MCP servers widget (US-023). Shows the real connected count from
 * /api/claude/mcp (US-004 — config-derived from ~/.claude.json global + project
 * mcpServers, minus needs-auth, enriched by a live session's real statuses) over
 * the total known. Hovering reveals a shadcn Tooltip listing every server by
 * name with its status, flagging any that need (re)auth. Refetches on every WS
 * event (via useMcp's eventSeq) so the count tracks live session changes. The
 * Tooltip content is re-skinned with semantic tokens so it reads in light+dark.
 */
function McpWidget({ mcp, scope }: { mcp: McpState; scope: WidgetScope }) {
  const sub = mcp.fromLiveSession ? "connected · live" : "connected · total";
  return (
    <StatCard label="MCP servers" sub={sub} scope={scope}>
      {!mcp.hasData ? (
        <Dash />
      ) : (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${mcp.connectedCount} of ${mcp.servers.length} MCP servers connected${
                  mcp.needsAuthCount > 0 ? `, ${mcp.needsAuthCount} need auth` : ""
                }`}
                className="flex cursor-help items-baseline gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
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
              </button>
            </TooltipTrigger>
            <TooltipContent
              align="start"
              className="w-52 border border-border bg-card p-2 text-left text-foreground"
            >
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
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
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

/**
 * Model & idle widget (US-024). Shows the active (timeline-selected) session's
 * real model rendered as a friendly display name — "Opus 4.7" rather than the
 * raw "claude-opus-4-7[1m]" slug — alongside its idle/active state. Degrades to
 * "—" / "no session" when nothing is selected, and to "unknown" when a session
 * has no model recorded yet.
 */
function ModelIdleWidget({
  session,
  scope,
}: {
  session: Session | null;
  scope: WidgetScope;
}) {
  const idle = session ? session.status !== "running" : false;
  return (
    <StatCard
      label="Model & idle"
      sub={session ? session.status : "no session"}
      scope={scope}
    >
      {session == null ? (
        <Dash />
      ) : (
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {prettyModel(session.model ?? null)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {idle ? `idle ${sinceLabel(session.last_activity)}` : "active now"}
          </div>
        </div>
      )}
    </StatCard>
  );
}

/**
 * Turn a Claude model slug into a human display name: "claude-opus-4-7[1m]" →
 * "Opus 4.7", "claude-sonnet-4-6" → "Sonnet 4.6", "claude-haiku-4-5-20251001" →
 * "Haiku 4.5". Strips the "claude-" prefix, any "[…]" context marker, and a
 * trailing yyyymmdd date, then Title-cases the family and dots the version
 * numbers. Returns "unknown" when the model is missing, and the raw slug if it
 * doesn't parse.
 */
function prettyModel(model: string | null): string {
  if (!model) return "unknown";
  const s = model
    .replace(/^claude-/i, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/-\d{8}$/, "");
  const parts = s.split("-").filter(Boolean);
  const family = parts[0];
  if (!family) return model;
  const fam = family.charAt(0).toUpperCase() + family.slice(1);
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p));
  return nums.length ? `${fam} ${nums.join(".")}` : fam;
}

function GitWidget({ git, scope }: { git: CwdGit | null; scope: WidgetScope }) {
  return (
    <StatCard label="Git" sub="branch · dirty" scope={scope}>
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
 * Per-project last-session metrics widget (US-026). Surfaces the figures Claude
 * Code records under ~/.claude.json for the active cwd's project (US-010 backend,
 * GET /api/claude/project-metrics): the last session's cost, token totals
 * (in/out + cache read/creation), lines added/removed, and the per-model split.
 * cwd-scoped — it re-scopes when the toolbar working directory changes. Degrades
 * to "—" / "no data" for a project Claude Code has never run in (found:false) and
 * to a loading "—" before the first fetch. The model split (when more than one
 * model was used) is revealed on hover via a shadcn Tooltip. Semantic tokens only.
 */
function MetricsWidget({
  metrics,
  scope,
}: {
  metrics: ProjectMetrics | null;
  scope: WidgetScope;
}) {
  // Loading (null) or a project Claude Code has never run → empty face.
  if (metrics == null || !metrics.found) {
    return (
      <StatCard label="Last session" sub="no data" scope={scope}>
        <div className="flex items-center gap-2">
          <Dash />
          <span className="text-[11px] text-muted-foreground">
            {metrics == null ? "loading…" : "no run recorded"}
          </span>
        </div>
      </StatCard>
    );
  }

  const topModel = metrics.lastModelUsage[0]?.model ?? null;
  const tin = metrics.lastTotalInputTokens ?? 0;
  const tout = metrics.lastTotalOutputTokens ?? 0;
  const cache =
    (metrics.lastTotalCacheReadInputTokens ?? 0) +
    (metrics.lastTotalCacheCreationInputTokens ?? 0);
  const added = metrics.lastLinesAdded ?? 0;
  const removed = metrics.lastLinesRemoved ?? 0;
  const cost = metrics.lastCost;

  return (
    <StatCard label="Last session" sub={prettyModel(topModel)} scope={scope}>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-foreground">
          {cost != null ? `$${cost.toFixed(2)}` : "—"}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          ↑{fmtTokens(tin)} ↓{fmtTokens(tout)}
          {cache > 0 ? ` · ${fmtTokens(cache)} cache` : ""}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate">
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            +{added}
          </span>{" "}
          <span className="font-medium text-destructive">−{removed}</span>{" "}
          <span className="text-muted-foreground">lines</span>
        </span>
        {metrics.lastModelUsage.length > 1 && (
          <ModelSplit usage={metrics.lastModelUsage} />
        )}
      </div>
    </StatCard>
  );
}

/** Hover tooltip listing the per-model token/cost split (US-026). */
function ModelSplit({ usage }: { usage: ProjectMetrics["lastModelUsage"] }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${usage.length} models used this session`}
            className="shrink-0 cursor-help rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {usage.length} models
          </button>
        </TooltipTrigger>
        <TooltipContent
          align="end"
          className="w-56 border border-border bg-card p-2 text-left text-foreground"
        >
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Model split
          </div>
          <ul className="space-y-1">
            {usage.map((m) => (
              <li
                key={m.model}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="truncate text-foreground">
                  {prettyModel(m.model)}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  ${m.costUSD.toFixed(2)} · {fmtTokens(m.inputTokens + m.outputTokens)}
                </span>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
function UsageWidget({
  usage,
  scope,
}: {
  usage: UsageState;
  scope: WidgetScope;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Prefer the real scrape (US-005) when it carries at least one parsed window.
  const plan = usage.planUtilization;
  const hasPlan = !!plan && (!!plan.fiveHour || !!plan.sevenDay);
  if (hasPlan && plan) return <PlanUsage plan={plan} tick={tick} scope={scope} />;

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
    <StatCard
      label="Usage"
      sub={usage.rateLimited ? "rate limited" : "last 5h"}
      scope={scope}
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
  scope,
}: {
  plan: NonNullable<UsageState["planUtilization"]>;
  tick: number;
  scope: WidgetScope;
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
    <StatCard label="Usage" sub="plan · live" scope={scope}>
      <div className="flex items-center gap-2">
        <span
          className={"text-xl font-semibold " + STATUS_COLOR[plan.status]}
        >
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

/**
 * Stats / contribution-heatmap widget (US-015). Renders Claude Code's own usage
 * rollup (GET /api/claude/stats, US-002): a GitHub-style heatmap of the last
 * ~year of daily activity colored by the heat tokens (US-005), plus headline
 * stats (total tokens, active days, current/longest streak, favorite model and
 * hour). The grid is hand-rolled (zero deps); each cell carries a `title` so
 * hovering shows the date + message count. Degrades to "no activity yet" when
 * stats-cache.json is missing. Spans the full widget row.
 */
function StatsWidget({
  stats,
  scope,
}: {
  stats: StatsState;
  scope: WidgetScope;
}) {
  if (!stats.hasData || stats.dailyActivity.length === 0) {
    return (
      <StatCard label="Stats" sub="activity & streaks" scope={scope}>
        <span className="text-sm text-muted-foreground">no activity yet</span>
      </StatCard>
    );
  }

  // The day count that drives a cell's intensity: messages + tool calls.
  const dayCount = (d: DailyActivityCell) => d.messageCount + d.toolCallCount;
  const days = stats.dailyActivity.slice(-371); // ~53 weeks, GitHub-style.
  const max = days.reduce((m, d) => Math.max(m, dayCount(d)), 0);

  return (
    <StatCard label="Stats" sub="activity & streaks" scope={scope}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <Heatmap days={days} max={max} dayCount={dayCount} />
        <div className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-[11px] lg:shrink-0">
          <StatItem label="Tokens" value={fmtTokens(stats.totalTokens)} />
          <StatItem label="Active days" value={String(stats.activeDays)} />
          <StatItem
            label="Streak"
            value={`${stats.currentStreak}d`}
            hint={`best ${stats.longestStreak}d`}
          />
          <StatItem
            label="Top model"
            value={shortModel(stats.favoriteModel)}
            span2
          />
          <StatItem label="Peak hour" value={fmtHour(stats.favoriteHour)} />
        </div>
      </div>
    </StatCard>
  );
}

type DailyActivityCell = StatsState["dailyActivity"][number];

/**
 * Hand-rolled contribution grid: weeks as columns, weekdays (Sun→Sat) as the 7
 * rows. Leading blanks pad the first week so the first day lands on its real
 * weekday. Each cell's color is one of five heat tokens chosen by the day's
 * share of the busiest day; `title` gives the hover detail.
 */
function Heatmap({
  days,
  max,
  dayCount,
}: {
  days: DailyActivityCell[];
  max: number;
  dayCount: (d: DailyActivityCell) => number;
}) {
  const first = days[0];
  const lead = first ? weekday(first.date) : 0;
  return (
    <div className="grid grid-flow-col grid-rows-7 gap-[2px] overflow-x-auto">
      {Array.from({ length: lead }).map((_, i) => (
        <span key={`pad-${i}`} className="size-2.5 rounded-[2px]" />
      ))}
      {days.map((d) => {
        const c = dayCount(d);
        return (
          <span
            key={d.date}
            title={`${d.date}: ${d.messageCount} msg · ${d.toolCallCount} tools`}
            className={"size-2.5 rounded-[2px] " + HEAT_CLASS[heatLevel(c, max)]}
          />
        );
      })}
    </div>
  );
}

/** One labeled figure in the stats grid beside the heatmap. */
function StatItem({
  label,
  value,
  hint,
  span2,
}: {
  label: string;
  value: string;
  hint?: string;
  span2?: boolean;
}) {
  return (
    <div className={span2 ? "col-span-2" : undefined}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <div className="truncate font-semibold text-foreground">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Heat-token classes for intensity levels 0–4 (literal so Tailwind keeps them). */
const HEAT_CLASS = [
  "bg-heat-0",
  "bg-heat-1",
  "bg-heat-2",
  "bg-heat-3",
  "bg-heat-4",
] as const;

/** Map a day's count to an intensity level 0–4 relative to the busiest day. */
function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/** Weekday index (0=Sun..6=Sat) of a YYYY-MM-DD day, parsed as UTC. */
function weekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? 0 : d.getUTCDay();
}

/** Trim a long model slug to its recognizable tail (e.g. "claude-opus-4-7"). */
function shortModel(model: string | null): string {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/\[.*\]$/, "");
}

/** Format an hour-of-day (0–23) as "14:00", or "—" when unknown. */
function fmtHour(hour: number | null): string {
  if (hour == null) return "—";
  return `${String(hour).padStart(2, "0")}:00`;
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
