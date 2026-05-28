// ContextHeader.tsx — the always-visible context banner that sits flush above
// the terminal body, replacing the dedicated Context HUD tab. Same data
// derivation as the former ContextWidget (live `/context` capture preferred,
// estimate fallback), compressed into one 36px-tall row:
//
//   [● pct] · [model] · [used / window]  [────breakdown bar────]
//                                                                    [actions]
//
// Hovering a bar segment surfaces a styled tooltip ("Skills · 22k · 2.2%");
// clicking the bar opens a Popover with the full per-category row list +
// the honest "/context costs context" caveat, matching what the HUD widget
// used to show. Actions on the right adapt to pressure:
//
//   < 80% (calm)     — Auto toggle + ↻ /context
//   80–90% (armed)   — amber chrome + "Remind me later" + Compact (→ /handoff)
//   ≥ 90% (critical) — red chrome + pulsing dot + Compact only
//
// "Remind me later" snoozes the urgent prompt back to calm until pct climbs
// past the critical threshold; Compact POSTs /handoff into the correlated pty
// so the live session writes HANDOFF.md (Conan can't author it).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Session } from "../hooks/useSessions.ts";
import type {
  LiveContextCategory,
  WidgetData,
} from "../hooks/useWidgets.ts";
import { fmtTokens, resolveContextWindow } from "./Widgets.tsx";
import { apiBase } from "../lib/gateway.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover.tsx";

// Pressure thresholds for the banner — the design call that came out of the
// prototype: amber 80–90%, red ≥90%. Tighter than the old HUD widget's 95%
// critical line; the banner is the only context surface now, so a more
// conservative critical threshold avoids overrunning the window.
const ARM_THRESHOLD = 80;
const CRITICAL_THRESHOLD = 90;

/** Mirrors LIVE_CAT_COLOR in Widgets.tsx so the banner and any future HUD
 *  ribbons read the same color per category. */
const CAT_COLOR: Record<LiveContextCategory["key"], string> = {
  system: "bg-chart-4",
  tools: "bg-chart-2",
  mcp: "bg-chart-3",
  memory: "bg-chart-1",
  skills: "bg-chart-5",
  messages: "bg-primary",
  free: "bg-muted-foreground/25",
};

/** A unified per-category row the banner consumes regardless of the source
 *  (live capture vs on-disk estimate) — keeps the bar + popover code one path. */
interface BannerCategory {
  key: LiveContextCategory["key"];
  label: string;
  tokens: number;
  /** Share of the context window, in percent (matches /context). */
  pct: number;
}

interface ContextHeaderProps {
  activeSession: Session | null;
  /** All known sessions — lets the estimate fallback infer a 1M window. */
  sessions?: Session[];
  data: WidgetData | null;
  token?: string | null;
  /** Re-pull the widgets payload (after a /context capture lands). */
  onRefetch?: () => void;
}

export default function ContextHeader({
  activeSession,
  sessions,
  data,
  token,
  onRefetch,
}: ContextHeaderProps) {
  // --- pressure-prompt snooze + Compact pending state ----------------------
  const [snoozed, setSnoozed] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactSent, setCompactSent] = useState(false);
  // --- breakdown-bar hover state -------------------------------------------
  // Custom mouse-tracking tooltip (not Radix's). The pill follows the cursor
  // along the bar rather than parking at the bar's center — natural for a
  // skinny segmented bar where you want to see "what is THAT segment". We
  // track viewport-relative mouseX on each pointer move and render a small
  // floating div clamped to the viewport. The bar itself is still the
  // Popover trigger (click → full per-category rows).
  const [hovered, setHovered] = useState<{
    label: string;
    tokensLabel: string;
    pct: number;
    colorClass: string;
  } | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const barRef = useRef<HTMLButtonElement | null>(null);
  // Bar bottom in viewport coords — refreshed on every show + window resize so
  // the tooltip stays glued just below the bar even if the layout shifts (HUD
  // resize, terminal-tab split, etc.). useLayoutEffect runs before paint so
  // the tooltip doesn't flash at a stale position.
  const [barBottom, setBarBottom] = useState(0);
  useLayoutEffect(() => {
    const update = () => {
      const el = barRef.current;
      if (el) setBarBottom(el.getBoundingClientRect().bottom);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [hovered !== null]);

  // --- adaptive /context auto-refresh toggle (US-006 v4.4) ------------------
  // Reads the gateway's persisted gate so the toggle reflects state across
  // reloads. `null` until the fetch resolves so we don't flash a wrong value.
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiBase() + "/api/claude/context/autorefresh", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.enabled === "boolean")
          setAutoOn(d.enabled);
      })
      .catch(() => {
        /* gateway unreachable — leave the toggle hidden */
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

  // --- on-demand `↻ /context` refresh --------------------------------------
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );
  const refresh = async () => {
    if (!activeSession || !token || refreshing) return;
    setRefreshing(true);
    try {
      await fetch(
        apiBase() +
          `/api/claude/sessions/${encodeURIComponent(activeSession.id)}/context/refresh`,
        { method: "POST", headers: { "x-conan-token": token } },
      );
    } catch {
      /* best-effort — fall back to whatever surfaces over WS */
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

  // --- derive the banner row from whichever face is freshest ---------------
  const liveCtx = data?.liveContext ?? null;
  const hasLivePty = data?.hasLivePty ?? false;
  let pct: number | null = null;
  let usedTokens: number | null = null;
  let windowTokens: number | null = null;
  let modelDisplay: string | null = null;
  let categories: BannerCategory[] = [];

  if (liveCtx) {
    // EXACT /context capture: trust the gateway's parsed numbers as-is.
    pct =
      liveCtx.usedPct ??
      (liveCtx.usedTokens != null && liveCtx.windowTokens
        ? Math.min(100, (liveCtx.usedTokens / liveCtx.windowTokens) * 100)
        : null);
    usedTokens = liveCtx.usedTokens;
    windowTokens = liveCtx.windowTokens;
    modelDisplay = liveCtx.modelDisplay ?? liveCtx.model;
    categories = liveCtx.categories.map((c) => ({
      key: c.key,
      label: c.label,
      tokens: c.tokens,
      pct: c.pct,
    }));
  } else {
    // Estimate fallback: latest assistant-turn usage from the transcript +
    // on-disk category breakdown. Free space is computed as the remainder.
    const ctx = data?.context ?? null;
    const u = ctx?.used ?? activeSession?.context_tokens ?? null;
    const w =
      ctx?.windowTokens ??
      resolveContextWindow(
        ctx?.model ?? activeSession?.model ?? null,
        u,
        sessions ?? (activeSession ? [activeSession] : []),
      );
    usedTokens = u;
    windowTokens = w;
    modelDisplay = ctx?.model ?? activeSession?.model ?? null;
    pct = u != null && w ? Math.min(100, (u / w) * 100) : null;
    const bd = data?.contextBreakdown ?? null;
    if (bd && w) {
      categories = bd.categories.map((c) => ({
        key: c.key,
        label: c.label,
        tokens: c.tokens,
        pct: (c.tokens / w) * 100,
      }));
    }
  }
  // Cap the categorised share so the Free remainder never goes negative on
  // estimate drift; sum could exceed `pct` if the breakdown approximates loose.
  const catSum = categories.reduce((s, c) => s + c.pct, 0);
  const freePct = Math.max(0, 100 - catSum);

  // --- pressure state -------------------------------------------------------
  const warn = pct != null && pct >= ARM_THRESHOLD && pct < CRITICAL_THRESHOLD;
  const critical = pct != null && pct >= CRITICAL_THRESHOLD;
  // Urgent (red/amber chrome) whenever armed unless the user snoozed below
  // critical. Snooze auto-clears at critical.
  const pressured = warn || critical;
  const urgent = pressured && (critical || !snoozed);
  const canRemind = warn && !snoozed;
  const canCompact =
    urgent && !!activeSession && !!token && hasLivePty && !compacting;
  // Reset snooze when the underlying pressure clears (back to calm).
  useEffect(() => {
    if (!pressured && snoozed) setSnoozed(false);
  }, [pressured, snoozed]);

  const compact = async () => {
    if (!canCompact) return;
    setCompacting(true);
    try {
      await fetch(
        apiBase() +
          `/api/claude/sessions/${encodeURIComponent(activeSession!.id)}/handoff`,
        { method: "POST", headers: { "x-conan-token": token! } },
      );
      setCompactSent(true);
    } catch {
      /* best-effort — handoff either typed into the pty or it didn't */
    } finally {
      setCompacting(false);
    }
  };

  // --- chrome class lookups -------------------------------------------------
  const containerCls =
    "flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs " +
    (critical
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : urgent
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border bg-card text-muted-foreground");
  const dotCls =
    "size-2 shrink-0 rounded-full " +
    (critical
      ? "animate-pulse bg-destructive"
      : urgent
        ? "bg-amber-500"
        : pct != null
          ? "bg-emerald-500"
          : "bg-muted-foreground/40");

  const pctLabel = pct != null ? `${Math.round(pct)}%` : "—";
  const usedLabel =
    usedTokens != null && windowTokens != null
      ? `${fmtTokens(usedTokens)} / ${fmtTokens(windowTokens)}`
      : "—";

  const compactTitle = !urgent
    ? "Available once context is running low (≥80%)"
    : hasLivePty
      ? "Runs /handoff in the live terminal — the session writes HANDOFF.md, then you can /compact"
      : "No live terminal correlated with this session";

  return (
    <div className={containerCls}>
      {/* Pct dot + headline numbers --------------------------------------- */}
      <span className={dotCls} />
      <span className="font-semibold tabular-nums">{pctLabel}</span>
      {pressured && (
        <span className={"shrink-0 font-medium " + (critical ? "tracking-wider" : "")}>
          {critical ? "CRITICAL" : "running low"}
        </span>
      )}
      <span className="text-muted-foreground/60">·</span>
      <span className="truncate text-foreground">
        {modelDisplay ?? "—"}
      </span>
      <span className="text-muted-foreground/60">·</span>
      <span className="tabular-nums">{usedLabel}</span>

      {/* Stacked breakdown bar — segments sized by share of window. Each
          segment updates `hovered` (which segment) + `tipPos` (where the
          pointer is) on mouseMove; the custom tooltip pill rendered after
          the bar reads both and follows the cursor. The whole bar is also a
          Popover trigger (click → full per-category rows); the tooltip is
          suppressed while the popover is open to avoid two stacked overlays. */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            ref={barRef}
            type="button"
            aria-label="Show context breakdown"
            onMouseLeave={() => {
              setHovered(null);
              setTipPos(null);
            }}
            onMouseMove={(e) => setTipPos({ x: e.clientX, y: e.clientY })}
            className="ml-1 flex h-2.5 min-w-20 flex-1 overflow-hidden rounded-full bg-muted outline-none transition-shadow hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
          >
            {categories.map((c) => (
              <span
                key={c.key}
                onMouseEnter={() =>
                  setHovered({
                    label: c.label,
                    tokensLabel: fmtTokens(c.tokens),
                    pct: c.pct,
                    colorClass: CAT_COLOR[c.key],
                  })
                }
                className={
                  CAT_COLOR[c.key] +
                  " block h-full cursor-pointer transition-opacity hover:opacity-70"
                }
                style={{ width: `${c.pct}%` }}
              />
            ))}
            {freePct > 0 && (
              <span
                onMouseEnter={() =>
                  setHovered({
                    label: "Free",
                    tokensLabel: "—",
                    pct: freePct,
                    colorClass: CAT_COLOR.free,
                  })
                }
                className={
                  CAT_COLOR.free +
                  " block h-full cursor-pointer transition-opacity hover:opacity-70"
                }
                style={{ width: `${freePct}%` }}
              />
            )}
          </button>
        </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            className="w-80 space-y-3 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                Context breakdown
              </span>
              <span className="text-[11px] text-muted-foreground">
                {liveCtx ? "live · from /context" : "≈ estimated"}
              </span>
            </div>
            <div className="flex items-baseline gap-2 text-sm font-semibold tabular-nums text-foreground">
              <span>{pctLabel}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {usedLabel}
              </span>
            </div>
            <div className="space-y-0.5">
              {categories.map((c) => (
                <div
                  key={c.key}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span
                    className={"size-1.5 shrink-0 rounded-full " + CAT_COLOR[c.key]}
                  />
                  <span className="text-foreground">{c.label}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {fmtTokens(c.tokens)}
                  </span>
                  <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                    {c.pct.toFixed(1)}%
                  </span>
                </div>
              ))}
              {freePct > 0 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <span
                    className={"size-1.5 shrink-0 rounded-full " + CAT_COLOR.free}
                  />
                  <span className="text-foreground">Free</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    —
                  </span>
                  <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                    {freePct.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
            <p className="border-t border-border pt-2 text-[10px] leading-tight text-muted-foreground/80">
              Refreshing runs <span className="font-medium">/context</span> in
              the session and itself consumes a few thousand tokens;
              auto-refresh only fires when context has moved a lot.
            </p>
        </PopoverContent>
      </Popover>

      {/* Mouse-tracking tooltip pill — fixed-positioned, centered on the
          cursor's clientX, sits 8px below the bar's bottom edge. Clamped to
          the viewport so it never spills off-screen at the edges. Suppressed
          while the popover is open. */}
      {hovered && tipPos && !popoverOpen && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: clampToViewport(tipPos.x, 200),
            top: barBottom + 8,
            transform: "translateX(-50%)",
          }}
          className="pointer-events-none z-50 flex items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md"
        >
          <span className={"size-2 rounded-full " + hovered.colorClass} />
          <span className="font-medium">{hovered.label}</span>
          <span className="tabular-nums opacity-80">{hovered.tokensLabel}</span>
          <span className="tabular-nums opacity-60">
            {hovered.pct.toFixed(1)}%
          </span>
        </div>
      )}

      <div className="ml-2 flex shrink-0 items-center gap-1.5">
        {!urgent && autoOn != null && (
          <button
            type="button"
            role="switch"
            aria-checked={autoOn}
            onClick={toggleAuto}
            title="Auto-track context: when on, Conan runs /context on a turn boundary (delta-triggered, not every turn) to keep this breakdown exact — which itself spends a few thousand tokens of context to measure context."
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
        {!urgent && hasLivePty && (
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
        {canRemind && (
          <button
            type="button"
            onClick={() => setSnoozed(true)}
            title="Snooze this reminder until context reaches the critical threshold"
            className="rounded px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            Remind me later
          </button>
        )}
        {urgent && (
          <button
            type="button"
            onClick={compact}
            disabled={!canCompact}
            title={compactTitle}
            className="rounded bg-destructive px-2 py-0.5 text-[10px] font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
          >
            {compacting ? "sending…" : compactSent ? "sent ✓" : "Compact"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Keep the tooltip pill (centered on the cursor) fully inside the viewport.
 *  Assumes `width` is an upper bound — anything more is clipped by overflow. */
function clampToViewport(x: number, width: number): number {
  const margin = 8;
  const half = width / 2;
  const min = margin + half;
  const max = window.innerWidth - margin - half;
  if (max < min) return x; // window too narrow for clamp; let it spill
  return Math.max(min, Math.min(max, x));
}
