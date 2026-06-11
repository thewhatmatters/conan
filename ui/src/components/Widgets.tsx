import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "../hooks/useSessions.ts";
import type {
  LiveUsage,
  ModelUsage,
  UsageState,
  UsageWindow,
  UsageWindows,
} from "../hooks/useUsage.ts";
import type {
  ContextCategory,
  LiveContext,
  LiveContextCategory,
  WidgetData,
} from "../hooks/useWidgets.ts";
import { ProgressCircle } from "./charts/ProgressCircle.tsx";
import StatCard from "./StatCard.tsx";
import { apiBase } from "../lib/gateway.ts";

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
  token,
  onRefetch,
  sessions,
}: {
  session: Session | null;
  data: WidgetData | null;
  token?: string | null;
  onRefetch?: () => void;
  /** All known sessions — lets the estimate infer a 1M window install-wide. */
  sessions?: Session[];
}) {
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const liveCtx = data?.liveContext ?? null;
  const hasLivePty = data?.hasLivePty ?? false;

  // Adaptive /context auto-refresh flag (US-006): the gateway holds the runtime
  // gate for autoRefreshContextOnStop (defaulting from CONAN_CONTEXT_AUTOREFRESH),
  // so reading it on mount reflects the persisted setting across reloads. `null`
  // until the fetch resolves, so the toggle stays hidden rather than flashing a
  // wrong state.
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiBase() + "/api/claude/context/autorefresh", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.enabled === "boolean") setAutoOn(d.enabled);
      })
      .catch(() => {
        /* leave the toggle hidden if the gateway is unreachable */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toggleAuto = async () => {
    if (!token || autoOn == null) return;
    const next = !autoOn;
    setAutoOn(next); // optimistic
    try {
      const r = await fetch(apiBase() + "/api/claude/context/autorefresh", {
        method: "POST",
        headers: { "x-conan-token": token, "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const d = r.ok ? await r.json() : null;
      if (d && typeof d.enabled === "boolean") setAutoOn(d.enabled);
      else setAutoOn(!next); // revert on a non-OK response
    } catch {
      setAutoOn(!next); // revert on failure
    }
  };

  // On-demand refresh: inject `/context` into the correlated pty (US-009), then
  // poll the widgets payload a few times so the passively-captured frame surfaces.
  const refresh = async () => {
    if (!session || !token || refreshing) return;
    setRefreshing(true);
    try {
      await fetch(
        apiBase() +
          `/api/claude/sessions/${encodeURIComponent(session.id)}/context/refresh`,
        { method: "POST", headers: { "x-conan-token": token } },
      );
    } catch {
      /* best-effort — fall back to whatever surfaces */
    }
    let n = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      onRefetch?.();
      if (++n >= 6) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setRefreshing(false);
      }
    }, 700);
  };

  // Refresh controls (US-006): one inline control group — the "Auto" toggle (the
  // adaptive auto-inject gate) alongside the manual ↻ /context button. The toggle
  // shows once its state loads; the manual button only when a live pty is
  // correlated (it types into it). Both are honest about the token cost.
  const refreshBtn =
    autoOn != null || hasLivePty ? (
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {autoOn != null && (
          <button
            type="button"
            role="switch"
            aria-checked={autoOn}
            onClick={toggleAuto}
            title="Auto-track context: when on, Conan runs /context on a turn boundary (delta-triggered, not every turn) to keep this breakdown exact — which itself spends a few thousand tokens of context to measure context. When off, only the manual ↻ refresh updates it."
            className={
              "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
              (autoOn
                ? "bg-primary/10 text-primary hover:bg-primary/20"
                : "text-muted-foreground hover:bg-muted")
            }
          >
            {autoOn ? "Auto ✓" : "Auto ○"}
          </button>
        )}
        {hasLivePty && (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="Run /context in the live terminal and capture the exact breakdown — note: each refresh consumes a few thousand tokens of context"
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {refreshing ? "capturing…" : "↻ /context"}
          </button>
        )}
      </div>
    ) : null;

  // Build the scrollable content (live face if we have a /context capture, else
  // the on-disk estimate) plus the pct that drives the pinned action toolbar.
  let content: ReactNode;
  let barPct: number | null;

  // --- live face: the EXACT /context capture (US-009) -----------------------
  if (liveCtx) {
    barPct =
      liveCtx.usedPct ??
      (liveCtx.usedTokens != null && liveCtx.windowTokens
        ? Math.min(100, (liveCtx.usedTokens / liveCtx.windowTokens) * 100)
        : null);
    content = <LiveContextView live={liveCtx} refreshBtn={refreshBtn} />;
  } else {
    // --- fallback: the on-disk estimate (US-007/US-013) ---------------------
    const ctx = data?.context ?? null;
    const ctxTokens = ctx?.used ?? session?.context_tokens ?? null;
    // Prefer the gateway-computed window (it resolves the 1M beta across
    // sessions); fall back to the local resolver when there's no transcript.
    const ctxWindow =
      ctx?.windowTokens ??
      resolveContextWindow(
        ctx?.model ?? session?.model ?? null,
        ctxTokens,
        sessions ?? (session ? [session] : []),
      );
    barPct =
      ctxTokens != null ? Math.min(100, (ctxTokens / ctxWindow) * 100) : null;
    const sub = session ? "≈ estimated" : "no session";
    const breakdown = data?.contextBreakdown ?? null;
    content = (
      <StatCard label="Context" sub={sub}>
        <div className="flex items-center gap-3">
          <ProgressCircle
            value={barPct ?? 0}
            radius={26}
            strokeWidth={5}
            variant={barPct != null && barPct >= 80 ? "error" : "default"}
            className="shrink-0"
          >
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {barPct != null ? `${Math.round(barPct)}%` : "—"}
            </span>
          </ProgressCircle>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              {barPct != null ? "CONTEXT USED" : "NO USAGE YET"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {ctxTokens != null
                ? `${fmtTokens(ctxTokens)} / ${fmtTokens(ctxWindow)}`
                : "—"}
            </div>
          </div>
          {refreshBtn}
        </div>
        {breakdown && breakdown.categories.length > 0 && (
          <ContextBreakdownBar breakdown={breakdown} />
        )}
      </StatCard>
    );
  }

  // The Context tab is a flex column: the action toolbar is PINNED to the top
  // (just under the tab strip) so its actions stay in view no matter how far the
  // breakdown below it scrolls (the bar is always present now; its actions are
  // disabled until context crosses the pressure threshold).
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ContextActionBar
        ctxPct={barPct}
        session={session}
        token={token}
        hasLivePty={hasLivePty}
      />
      <div className="min-h-0 flex-1 overflow-auto">{content}</div>
    </div>
  );
}

/**
 * Context-pressure action toolbar (US-013). A fixed bar pinned to the TOP of the
 * Context tab (just under the tab strip) — always visible so the Compact action
 * stays in view however far the breakdown below scrolls. Two pressure tiers:
 *
 *  - **< 80%** — calm/neutral; Compact inert.
 *  - **80–95% (running low)** — destructive-red label; Compact armed.
 *  - **≥ 95% (critical)** — same red, label escalated; Compact armed.
 *
 * Compact injects `/handoff` into the correlated pty so the SESSION writes
 * HANDOFF.md (Conan can't author it — only the live conversation knows its own
 * state); the user then runs `/compact` themselves to fold the context. Needs
 * a live correlated pty to type into.
 *
 * (The "Remind me later" snooze that gated this between 80–95% in the original
 * design was dropped — the bar is already passive enough that an extra dismiss
 * step felt like ceremony, not signal.)
 */
const CTX_ARM_THRESHOLD = 80;
const CTX_CRITICAL_THRESHOLD = 95;
function ContextActionBar({
  ctxPct,
  session,
  token,
  hasLivePty,
}: {
  ctxPct: number | null;
  session: Session | null;
  token?: string | null;
  hasLivePty: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const pressured = ctxPct != null && ctxPct >= CTX_ARM_THRESHOLD;
  const critical = ctxPct != null && ctxPct >= CTX_CRITICAL_THRESHOLD;
  const canCompact = pressured && !!session && !!token && hasLivePty && !busy;

  const compact = async () => {
    if (!canCompact) return;
    setBusy(true);
    try {
      await fetch(
        apiBase() +
          `/api/claude/sessions/${encodeURIComponent(session!.id)}/handoff`,
        { method: "POST", headers: { "x-conan-token": token! } },
      );
      setSent(true);
    } catch {
      /* best-effort — the command either typed into the pty or it didn't */
    } finally {
      setBusy(false);
    }
  };

  const compactTitle = !pressured
    ? "Available once context is running low (≥80%)"
    : !hasLivePty
      ? "No live terminal correlated with this session"
      : "Runs /handoff in the live terminal session — the session writes HANDOFF.md, then you can /compact";

  return (
    <div
      className={
        "shrink-0 border-b px-3 py-2 " +
        (pressured ? "border-destructive/30 bg-destructive/5" : "border-border")
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={
            "text-[11px] font-medium " +
            (pressured ? "text-destructive" : "text-muted-foreground")
          }
        >
          {ctxPct != null ? `Context ${Math.round(ctxPct)}%` : "Context —"}
          {pressured ? (critical ? " — critical" : " — running low") : ""}
        </span>
        <button
          type="button"
          onClick={compact}
          disabled={!canCompact}
          title={compactTitle}
          className="ml-auto rounded bg-destructive px-2 py-0.5 text-[11px] font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
        >
          {busy ? "sending…" : sent ? "sent ✓" : "Compact"}
        </button>
      </div>
      <p className="mt-1 text-[10px] leading-tight text-muted-foreground/70">
        Compact runs <span className="font-medium">/handoff</span> in the
        terminal session; HANDOFF.md is written by the session, not by Conan.
      </p>
    </div>
  );
}

/** Per-category chart color for the live /context segments (US-009). */
const LIVE_CAT_COLOR: Record<LiveContextCategory["key"], string> = {
  system: "bg-chart-4",
  tools: "bg-chart-2",
  mcp: "bg-chart-3",
  memory: "bg-chart-1",
  skills: "bg-chart-5",
  messages: "bg-primary",
  free: "bg-muted-foreground/25",
};

/**
 * The live face of the Context widget (US-009): the EXACT /context breakdown
 * scraped from the correlated pty — model header, total %-of-window ring (>=80%
 * → destructive), and a per-category row list including the Free space row,
 * matching the /context layout. Distinguished from the estimate by the
 * "live · from /context" sub-label.
 */
function LiveContextView({
  live,
  refreshBtn,
}: {
  live: LiveContext;
  refreshBtn: ReactNode;
}) {
  const pct =
    live.usedPct ??
    (live.usedTokens != null && live.windowTokens
      ? Math.min(100, (live.usedTokens / live.windowTokens) * 100)
      : null);
  const total = live.categories.reduce((s, c) => s + c.pct, 0) || 100;
  return (
    <StatCard label="Context" sub="live · from /context">
      <div className="flex items-center gap-3">
        <ProgressCircle
          value={pct ?? 0}
          radius={26}
          strokeWidth={5}
          variant={pct != null && pct >= 80 ? "error" : "default"}
          className="shrink-0"
        >
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {pct != null ? `${Math.round(pct)}%` : "—"}
          </span>
        </ProgressCircle>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {live.modelDisplay ?? live.model ?? "CONTEXT USED"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {live.usedTokens != null && live.windowTokens != null
              ? `${fmtTokens(live.usedTokens)} / ${fmtTokens(live.windowTokens)}`
              : (live.model ?? "—")}
          </div>
        </div>
        {refreshBtn}
      </div>
      {/* stacked mini-bar by share of window (includes Free space) */}
      <span className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {live.categories.map((c) => (
          <span
            key={c.key}
            className={LIVE_CAT_COLOR[c.key]}
            style={{ width: `${(c.pct / total) * 100}%` }}
            title={`${c.label}: ${fmtTokens(c.tokens)} tokens (${c.pct}%)`}
          />
        ))}
      </span>
      {/* per-category rows, in /context order, including Free space */}
      <div className="mt-1.5 space-y-0.5">
        {live.categories.map((c) => (
          <div key={c.key} className="flex items-center gap-2 text-[11px]">
            <span className={"size-1.5 shrink-0 rounded-full " + LIVE_CAT_COLOR[c.key]} />
            <span className="text-foreground">{c.label}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {fmtTokens(c.tokens)}
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
              {c.pct}%
            </span>
          </div>
        ))}
      </div>
      {/* Honest cost (US-002): a /context refresh injects into the session and
          itself consumes context, so auto-refresh is delta-triggered, not per-turn. */}
      <p className="mt-2 text-[10px] leading-tight text-muted-foreground/70">
        Refreshing runs /context in the session and consumes a few thousand
        tokens; auto-refresh only fires when context has moved a lot.
      </p>
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
 * The Usage tab's ↻ /usage refresh control (US-006). Lifted out of UsageWidget's
 * faces so it can ride the shared <HudTabHeader> secondary toolbar like the
 * other HUD tabs, instead of moving around with whichever Usage face renders.
 * Injects `/usage` into the correlated pty (US-010), then polls the usage
 * payload a few times so the passively-captured frame surfaces. Mirrors the
 * Context tab's ↻ /context gating: it only renders when a live pty is correlated
 * (it types into it), and shows a "capturing…" busy state while polling.
 */
export function UsageRefreshButton({
  session,
  token,
  hasLivePty,
  onRefetch,
}: {
  session?: Session | null;
  token?: string | null;
  hasLivePty?: boolean;
  onRefetch?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );
  const refresh = async () => {
    if (!session || !token || refreshing) return;
    setRefreshing(true);
    try {
      await fetch(
        apiBase() +
          `/api/claude/sessions/${encodeURIComponent(session.id)}/usage/refresh`,
        { method: "POST", headers: { "x-conan-token": token } },
      );
    } catch {
      /* best-effort — fall back to whatever surfaces */
    }
    let n = 0;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      onRefetch?.();
      if (++n >= 6) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setRefreshing(false);
      }
    }, 700);
  };

  // Only when a live pty is correlated (it types into it) — mirrors ↻ /context.
  if (!hasLivePty) return null;
  return (
    <button
      type="button"
      onClick={refresh}
      disabled={refreshing}
      title="Run /usage in the live terminal and capture the exact Session block + windows"
      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
    >
      {refreshing ? "capturing…" : "↻ /usage"}
    </button>
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
export function UsageWidget({
  usage,
  hasLivePty = false,
}: {
  usage: UsageState;
  /** True when the active terminal has a correlated live `claude` pty — drives
   *  the empty-Session hint (clickable vs "no live session"). */
  hasLivePty?: boolean;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // US-007: the account-global windows slot (US-006) — the latest rate-limit
  // windows from ANY session's capture (or the probe) serve every tab, with
  // `capturedAt` driving the "captured Xm ago" freshness hint in both faces.
  const windows = usage.usageWindows;

  // --- live face: the EXACT /usage capture (US-010) -------------------------
  if (usage.liveUsage) {
    return <LiveUsageView live={usage.liveUsage} windows={windows} tick={tick} />;
  }

  // Prefer the real scrape (US-005) when it carries at least one parsed window.
  const plan = usage.planUtilization;
  const hasPlan = !!plan && (!!plan.fiveHour || !!plan.sevenDay);
  if (hasPlan && plan) {
    return (
      <PlanUsage plan={plan} windows={windows} tick={tick} hasLivePty={hasLivePty} />
    );
  }

  // --- baseline: no /usage scrape yet ---------------------------------------
  // Render the same shape PlanUsage/LiveUsageView would, with `—` placeholders
  // so the user sees the data layout that's waiting. A rate-limited posture
  // still gets a visible Limited chip up top.
  return <EmptyUsageView hasLivePty={hasLivePty} rateLimited={usage.rateLimited} />;
}

// STATUS_COLOR / StatusChip / worstWindow were removed when the Usage faces
// dropped their top-level worst-% headline (matching Claude's /usage TUI which
// shows no aggregate). Per-window posture is conveyed through the bar color
// (PlanWindowRow's `barColor`) + the rendered "% used" value.

/**
 * The REAL plan-utilization face of the Usage widget (US-025/US-010): the 5-hour,
 * 7-day all-models, and 7-day Sonnet-only windows' "% used" + per-window reset
 * countdown, headlined by the worst window and tinted by the scrape's posture.
 * The countdown ticks off `tick`. These windows are account-global (probe).
 */
function PlanUsage({
  plan,
  windows,
  tick,
  hasLivePty,
}: {
  plan: NonNullable<UsageState["planUtilization"]>;
  /** Account-global windows slot (US-006/US-007) — preferred windows source. */
  windows: UsageWindows | null;
  tick: number;
  /** Drives the empty-Session hint copy — clickable vs "no live session". */
  hasLivePty: boolean;
}) {
  // The /usage TUI doesn't render a top-level worst-% headline — it just
  // lists each window with its bar, "X% used", and reset line. We mirror that
  // here for cohesion with the source the user might be checking against.
  // Limit/Warning state is read from the bar color + the "% used" value.
  // US-007: windows come from the account-global slot (any session's capture
  // serves every tab); `plan` is the same slot's legacy view, kept as fallback.
  const hint = fmtCapturedAgo(windows?.capturedAt ?? plan.probedAt, tick);
  return (
    <StatCard sub={"plan · live" + (hint ? ` · ${hint}` : "")}>
      <div className="space-y-3">
        <PlanWindowRow
          kind="session"
          win={windows?.fiveHour ?? plan.fiveHour}
          tick={tick}
        />
        <PlanWindowRow
          kind="week-all"
          win={windows?.sevenDay ?? plan.sevenDay}
          tick={tick}
        />
        <PlanWindowRow
          kind="week-sonnet"
          win={windows?.sevenDaySonnet ?? plan.sevenDaySonnet}
          tick={tick}
        />
      </div>
      {/* The Session block scaffold renders empty here so users see the data
          shape that's waiting — clicking ↻ /usage above captures the real
          numbers and the same skeleton fills with values (LiveUsageView). */}
      <EmptySessionBlock hasLivePty={hasLivePty} />
    </StatCard>
  );
}

/**
 * The "waiting for /usage capture" empty-state mirror of LiveUsageView (US-010).
 * Renders the same scaffolding — three rate-limit windows up top, then the
 * Session block (Cost/Code/API/Wall grid + an All-models token row) — but with
 * `—` placeholders and softened opacity so it reads as the layout that data
 * will fill, not stale numbers. Clicking ↻ /usage in the toolbar above triggers
 * the capture; LiveUsageView replaces this skeleton on the next refetch.
 */
function EmptyUsageView({
  hasLivePty,
  rateLimited,
}: {
  hasLivePty: boolean;
  rateLimited: boolean;
}) {
  return (
    <StatCard sub={rateLimited ? "rate limited" : "awaiting /usage capture"}>
      <div className="space-y-3 opacity-60">
        <EmptyPlanWindowRow kind="session" />
        <EmptyPlanWindowRow kind="week-all" />
        <EmptyPlanWindowRow kind="week-sonnet" />
      </div>
      <EmptySessionBlock hasLivePty={hasLivePty} />
    </StatCard>
  );
}

/**
 * Empty scaffold for one rate-limit window row — mirrors PlanWindowRow's
 * label + bar + reset-line shape, but with an empty bar and `—`/"Awaiting
 * capture" placeholders. Wrapped by EmptyUsageView and (indirectly) by
 * PlanUsage's empty Session footer.
 */
function EmptyPlanWindowRow({ kind }: { kind: WindowKind }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate font-medium text-foreground">
          {WINDOW_LABELS[kind]}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">—</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" />
      <div className="text-[10px] text-muted-foreground">Awaiting capture</div>
    </div>
  );
}

/**
 * The Session-block portion of the empty state. Used both by EmptyUsageView
 * (no windows captured yet) and by PlanUsage (windows captured, but no
 * session-specific block yet). Cost/Code/API/Wall grid + an All-models row
 * with `—` token counts so the per-model layout is visible too.
 */
function EmptySessionBlock({ hasLivePty }: { hasLivePty: boolean }) {
  return (
    <div className="-mx-3 mt-2 border-t border-border px-3 pt-1.5 opacity-60">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Session
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <SessionStat label="Cost" value="—" />
        <SessionStat label="Code" value="—" />
        <SessionStat label="API" value="—" />
        <SessionStat label="Wall" value="—" />
      </div>
      <div className="mt-1.5 text-[11px]">
        <div className="truncate font-medium text-foreground">All models</div>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
          <span className="tabular-nums">— in</span>
          <span className="tabular-nums">— out</span>
          <span className="tabular-nums">— cache-r</span>
          <span className="tabular-nums">— cache-w</span>
        </div>
      </div>
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        {hasLivePty
          ? "Click ↻ /usage above to capture this session's stats."
          : "Awaiting a live Claude session to capture /usage from."}
      </div>
    </div>
  );
}

/**
 * The LIVE face of the Usage widget (US-010): the EXACT /usage capture from the
 * correlated pty — the session-specific Session block (cost, API/wall durations,
 * code changes, per-model token usage) plus all three account-global windows.
 * Distinguished from the probe by the "live · from /usage" sub-label.
 */
function LiveUsageView({
  live,
  windows,
  tick,
}: {
  live: LiveUsage;
  /** Account-global windows slot (US-006/US-007) — preferred windows source. */
  windows: UsageWindows | null;
  tick: number;
}) {
  const s = live.session;
  // US-007: the freshness hint reads the GLOBAL slot's capturedAt — the
  // windows' real capture time — not live.capturedAt, which the gateway
  // re-stamps on every transcript-derived response. Hidden when fresher
  // than ~1 min (fmtCapturedAgo returns "").
  const hint = fmtCapturedAgo(windows?.capturedAt, tick);
  return (
    <StatCard sub={"live · from /usage" + (hint ? ` · ${hint}` : "")}>
      {/* account-global rate-limit windows (US-006) — served from the global
          slot regardless of which session captured them; the frame's own
          windows are the fallback. Same layout as PlanUsage, mirrors Claude's
          /usage TUI (no top-level worst-% headline; status conveyed per-window
          through bar color + the "X% used" value). */}
      <div className="space-y-3">
        <PlanWindowRow
          kind="session"
          win={windows?.fiveHour ?? live.fiveHour}
          tick={tick}
        />
        <PlanWindowRow
          kind="week-all"
          win={windows?.sevenDay ?? live.sevenDay}
          tick={tick}
        />
        <PlanWindowRow
          kind="week-sonnet"
          win={windows?.sevenDaySonnet ?? live.sevenDaySonnet}
          tick={tick}
        />
      </div>

      {/* session-specific Session block */}
      {s && (
        <div className="-mx-3 mt-2 border-t border-border px-3 pt-1.5">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Session
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            {s.totalCostUsd != null && (
              <SessionStat label="Cost" value={`$${s.totalCostUsd.toFixed(2)}`} />
            )}
            {(s.linesAdded != null || s.linesRemoved != null) && (
              <SessionStat
                label="Code"
                value={`+${s.linesAdded ?? 0} / −${s.linesRemoved ?? 0}`}
              />
            )}
            {s.apiDurationMs != null && (
              <SessionStat label="API" value={fmtDuration(s.apiDurationMs)} />
            )}
            {s.wallDurationMs != null && (
              <SessionStat label="Wall" value={fmtDuration(s.wallDurationMs)} />
            )}
          </div>
          {s.byModel.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {s.byModel.map((m, i) => (
                <ModelUsageRow key={m.model ?? `m${i}`} usage={m} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* The v4.6 "What's contributing" insights + "Skills · % of usage"
          sections (US-007/008/009) were removed: the parsers concatenated
          words without spaces ("ofyourusagecamefromsessionsactivefor8+hours")
          because Claude's /usage TUI uses tight kerning the ANSI strip
          collapsed. The backend parsers + capture path stay wired (insights
          + skills still land on liveUsage) — only the render is gone.
          A future pass that fixes the parser whitespace can re-add the UI. */}
    </StatCard>
  );
}

/** One labeled Session-block stat (label left, value right). */
function SessionStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** One per-model usage row: model name + in/out/cache token counts (US-010). */
function ModelUsageRow({ usage }: { usage: ModelUsage }) {
  return (
    <div className="text-[11px]">
      <div className="truncate font-medium text-foreground">
        {usage.modelDisplay ?? usage.model ?? "All models"}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
        <span className="tabular-nums">{fmtTokens(usage.inputTokens)} in</span>
        <span className="tabular-nums">{fmtTokens(usage.outputTokens)} out</span>
        <span className="tabular-nums">
          {fmtTokens(usage.cacheReadTokens)} cache-r
        </span>
        <span className="tabular-nums">
          {fmtTokens(usage.cacheWriteTokens)} cache-w
        </span>
      </div>
    </div>
  );
}

/** Window kinds map 1:1 onto the three rate-limit buckets Claude reports:
 *  the 5-hour "current session", the 7-day all-models bucket, and the
 *  7-day Sonnet-only bucket. Labels mirror what the user sees in /usage. */
type WindowKind = "session" | "week-all" | "week-sonnet";
const WINDOW_LABELS: Record<WindowKind, string> = {
  session: "Current session",
  "week-all": "Current week (all models)",
  "week-sonnet": "Current week (Sonnet)",
};

/**
 * One rate-limit window — mirrors the layout the `/usage` TUI uses: the
 * sentence-cased label on top, the bar with "X% used" on the right, and a
 * muted "Resets …" line below carrying the absolute reset time + timezone.
 * Falls back to the EmptyPlanWindowRow skeleton when the upstream window is
 * null (e.g. no recent /usage probe), so the three rate-limit rows never
 * disappear and the layout stays consistent across all faces (US-005).
 */
function PlanWindowRow({
  kind,
  win,
  tick,
}: {
  kind: WindowKind;
  win: UsageWindow | null;
  tick: number;
}) {
  if (!win) return <EmptyPlanWindowRow kind={kind} />;
  const pct = Math.max(0, Math.min(100, win.utilizationPct));
  const barColor =
    win.utilizationPct >= 100
      ? "bg-destructive"
      : win.utilizationPct >= 80
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate font-medium text-foreground">
          {WINDOW_LABELS[kind]}
        </span>
        <span className="shrink-0 tabular-nums text-foreground">
          {win.utilizationPct}% used
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={"h-full rounded-full " + barColor}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">
        {fmtResetAbsolute(win.resetAt, tick)}
      </div>
    </div>
  );
}

/** Format a window's reset time the way Claude's /usage prints it:
 *   - same calendar day → "Resets 8pm (America/Chicago)"
 *   - future day        → "Resets Jun 1 at 3pm (America/Chicago)"
 *   - past / overdue    → "Resets due"
 *   - unknown           → "" (caller renders an empty placeholder line)
 *
 * Timezone comes from the user's system via `Intl` — Claude's TUI similarly
 * shows the local zone. Hours render without a `:00` minute (`8pm`, not
 * `8:00pm`) to match Claude's formatting; non-zero minutes get included
 * (`8:30pm`).
 */
function fmtResetAbsolute(resetAt: number | null, now: number): string {
  if (resetAt == null) return "";
  if (resetAt <= now) return "Resets due";

  const reset = new Date(resetAt);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hourOpts: Intl.DateTimeFormatOptions =
    reset.getMinutes() === 0
      ? { hour: "numeric", hour12: true }
      : { hour: "numeric", minute: "2-digit", hour12: true };
  const hourStr = new Intl.DateTimeFormat(undefined, hourOpts)
    .format(reset)
    .toLowerCase()
    .replace(/\s+/g, "");

  // Same calendar day comparison in the *user's local* zone (matches Claude's
  // "later today" framing). `toDateString` uses local time, so both Dates
  // here are evaluated against the local zone — correct by construction.
  const sameDay = reset.toDateString() === new Date(now).toDateString();
  if (sameDay) return `Resets ${hourStr} (${tz})`;

  const dateStr = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(reset);
  return `Resets ${dateStr} at ${hourStr} (${tz})`;
}

/* ---- shared bits --------------------------------------------------------- */

/**
 * Freshness hint for the account-global windows capture (US-007): "captured
 * 12m ago" / "captured 2h ago". Returns "" when the capture is fresher than
 * ~1 minute (fresh enough to need no caveat) or when no capture time exists —
 * callers render nothing in both cases.
 */
function fmtCapturedAgo(
  capturedAt: number | null | undefined,
  now: number,
): string {
  if (!capturedAt) return "";
  const mins = Math.floor((now - capturedAt) / 60_000);
  if (mins < 1) return "";
  if (mins < 60) return `captured ${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `captured ${h}h ago` : `captured ${Math.floor(h / 24)}d ago`;
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
/** Strip a "[variant]" suffix (e.g. "[1m]") down to the base model id. */
function baseModel(m: string | null | undefined): string {
  return (m ?? "").replace(/\[[^\]]*\]/g, "").trim();
}

/** True when a model slug marks the 1M-context variant. */
function is1m(m: string | null | undefined): boolean {
  return !!m && /1m/i.test(m);
}

/**
 * Resolve the context-window size for the on-disk estimate. The "[1m]" marker
 * only rides the SessionStart hook payload — the transcript model and a session
 * that missed its SessionStart both lack it — so a bare slug would wrongly
 * default a 1M-context session to 200k (showing ~99% instead of ~20%). We treat
 * the window as 1M when any of these hold:
 *   1. the model itself is a 1m variant;
 *   2. a sibling session on the SAME base model reports 1m (the 1M beta is
 *      install-wide for that model, so an unmarked sibling is on it too);
 *   3. the measured used tokens already exceed the 200k default — the window
 *      must be larger than 200k for that to be possible.
 * The live `/context` capture (when present) takes precedence over this estimate
 * and carries the exact window it parsed.
 */
export function resolveContextWindow(
  model: string | null,
  used: number | null,
  sessions: { model: string | null }[],
): number {
  if (is1m(model)) return 1_000_000;
  const base = baseModel(model);
  if (base && sessions.some((s) => is1m(s.model) && baseModel(s.model) === base))
    return 1_000_000;
  if (used != null && used > 200_000) return 1_000_000;
  return 200_000;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}
