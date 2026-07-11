import { useEffect, useState } from "react";
import type {
  LiveUsage,
  ModelUsage,
  UsageState,
  UsageWindow,
  UsageWindows,
} from "../hooks/useUsage.ts";
import StatCard from "./StatCard.tsx";

/* ---- widget cells -------------------------------------------------------- */
//
// The HUD ships one widget cell — Usage (global) — rendered as its own
// DevTools-style HUD tab and consumed by Hud.tsx. The Context cell that used
// to live here (US-004/US-007/US-009/US-013: ContextWidget + the
// ContextHeader banner it fed) was removed once Claude Code's own statusline
// started surfacing live context % directly in the terminal, making the
// scraped/estimated Context view redundant — see CLAUDE.md. The ↻ /usage
// refresh button (US-006/US-010) was removed once the OAuth usage poller
// (src/usage/oauthUsage.ts) made both the rate-limit windows AND the
// per-session Session block windows passively fresh with no pty injection —
// see CLAUDE.md.

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
    return (
      <LiveUsageView
        live={usage.liveUsage}
        windows={windows}
        source={usage.usageSource}
        tick={tick}
      />
    );
  }

  // Prefer the real scrape (US-005) when it carries at least one parsed window.
  const plan = usage.planUtilization;
  const hasPlan = !!plan && (!!plan.fiveHour || !!plan.sevenDay);
  if (hasPlan && plan) {
    return (
      <PlanUsage
        plan={plan}
        windows={windows}
        source={usage.usageSource}
        tick={tick}
        hasLivePty={hasLivePty}
      />
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
  source,
  tick,
  hasLivePty,
}: {
  plan: NonNullable<UsageState["planUtilization"]>;
  /** Account-global windows slot (US-006/US-007) — preferred windows source. */
  windows: UsageWindows | null;
  /** Which path produced these windows (US-008) — "oauth" vs "pty fallback" badge. */
  source: UsageState["usageSource"];
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
    <StatCard sub={"plan · live" + fmtUsageSource(source) + (hint ? ` · ${hint}` : "")}>
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
  source,
  tick,
}: {
  live: LiveUsage;
  /** Account-global windows slot (US-006/US-007) — preferred windows source. */
  windows: UsageWindows | null;
  /** Which path produced these windows (US-008) — "oauth" vs "pty fallback" badge. */
  source: UsageState["usageSource"];
  tick: number;
}) {
  const s = live.session;
  // US-007: the freshness hint reads the GLOBAL slot's capturedAt — the
  // windows' real capture time — not live.capturedAt, which the gateway
  // re-stamps on every transcript-derived response. Hidden when fresher
  // than ~1 min (fmtCapturedAgo returns "").
  const hint = fmtCapturedAgo(windows?.capturedAt, tick);
  return (
    <StatCard sub={"live · from /usage" + fmtUsageSource(source) + (hint ? ` · ${hint}` : "")}>
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

/**
 * Source badge suffix for the windows currently on screen (US-008): " ·
 * oauth" for the passive ~60s-cadence poller, " · pty fallback" for the
 * throttled-to-5min pty-probe path — two data sources with very different
 * freshness that otherwise look identical. "" when there's no data yet
 * (EmptyUsageView doesn't call this).
 */
function fmtUsageSource(source: UsageState["usageSource"]): string {
  if (source === "oauth") return " · oauth";
  if (source === "pty-probe") return " · pty fallback";
  return "";
}

/** Compact "1h 02m" / "12m 30s" / "45s" duration for the reset countdown. */
export function fmtDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}
