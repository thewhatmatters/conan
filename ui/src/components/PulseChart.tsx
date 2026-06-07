import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import conanIcon from "../assets/conan-icon.png";
import type { PulseSeries, PulseCategory } from "../hooks/usePulse.ts";
import { AreaChart } from "./charts/AreaChart.tsx";
import type { AvailableChartColorsKeys } from "../lib/chartUtils.ts";
import { useTier } from "../hooks/useTier.ts";
import { PREMIUM_PRICE } from "../lib/license.ts";

/* ───── US-103: Free-tier Pulse live-data cap ──────────────────────────────
 * After FREE_PULSE_GRACE_MS of cumulative session time with live data
 * visible, the chart blurs and a sticky-centered upgrade overlay drops.
 * Sticky for the session — switching HUD tabs (which unmounts/remounts
 * PulseChart) preserves the clock + walled state via module-level vars,
 * so a user can't escape by toggling tabs. Premium upgrade resets both.
 * This is the most aggressive gate in the suite — it walls live data,
 * a deliberate departure from "never gate live" — see CLAUDE.md §259-279. */
const FREE_PULSE_GRACE_MS = 60_000;

/** Module-level session state — survives PulseChart's tab-switch unmounts.
 *  `startedAt`: epoch ms when the Free-tier grace clock began (set on the
 *  first mount that sees live data). `walled`: latch flipped when the clock
 *  fires; once true, every subsequent mount renders the overlay
 *  immediately. Both are reset by `resetPulseSession()` when `useTier()`
 *  flips to premium. */
let pulseSessionStartedAt: number | null = null;
let pulseSessionWalled = false;
function resetPulseSession(): void {
  pulseSessionStartedAt = null;
  pulseSessionWalled = false;
}

/** Dispatch the same `conan:open-settings` event the Timeline upgrade
 *  overlay + RickrolledTicker use, so the Upgrade button here lands the
 *  user directly on the JWT paste field. */
function openLicenseSettings(): void {
  window.dispatchEvent(
    new CustomEvent("conan:open-settings", { detail: { tab: "license" } }),
  );
}

type Range = { label: string; minutes: number };
const RANGES: Range[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

/**
 * The 15m/1h/6h/24h window selector. Exported so the HUD can mount it in the
 * shared <HudTabHeader> toolbar (US-005) instead of the chart's own header,
 * keeping the range buttons pinned and the Pulse tab consistent with the
 * Skills/MCP/Usage tabs.
 */
export function PulseRange({
  minutes,
  onRange,
}: {
  minutes: number;
  onRange: (minutes: number) => void;
}) {
  return (
    // Flat toggle row sized to match the Usage tab's `↻ /usage` button
    // (px-1.5 py-0.5 text-[10px]) so the Pulse sub-header strip is the same
    // height as the Usage sub-header strip in the HUD — the old bordered box
    // (border + p-0.5 + text-xs) made the Pulse header visibly taller.
    <div className="flex gap-0.5 text-[10px]">
      {RANGES.map((r) => (
        <button
          key={r.minutes}
          onClick={() => onRange(r.minutes)}
          className={
            "rounded px-1.5 py-0.5 font-medium transition-colors " +
            (minutes === r.minutes
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted")
          }
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Activity categories the area stacks by (bottom → top), mapped 1:1 onto the
 * --color-chart-1..5 theme tokens (US-006 chartUtils). Mirrors PULSE_CATEGORIES
 * on the backend (src/pulse/index.ts). The display `label` is the data key fed
 * to the AreaChart so it doubles as the legend/tooltip label; `color` selects
 * the matching themed chart color.
 */
const CATEGORIES: {
  key: PulseCategory;
  label: string;
  color: AvailableChartColorsKeys;
  varName: string;
}[] = [
  { key: "tool", label: "Tools", color: "chart1", varName: "--color-chart-1" },
  { key: "assistant", label: "Assistant", color: "chart2", varName: "--color-chart-2" },
  { key: "prompt", label: "Prompts", color: "chart3", varName: "--color-chart-3" },
  { key: "session", label: "Session", color: "chart4", varName: "--color-chart-4" },
  { key: "other", label: "Other", color: "chart5", varName: "--color-chart-5" },
];

interface PulseChartProps {
  series: PulseSeries | null;
  minutes: number;
  onRange: (minutes: number) => void;
  /**
   * Render as a flush bottom strip inside the Dock (shorter plot, no card
   * chrome) instead of the standalone HUD panel.
   */
  compact?: boolean;
}

/**
 * US-007: the Pulse / throughput chart — migrated from a hand-rolled SVG to
 * Tremor's stacked AreaChart (recharts-based) so it gains real tooltips, a
 * legend, and responsive resizing while keeping its activity categories, time
 * ranges, and token-token theming. Each band is an activity category
 * (tool/assistant/prompt/...) bucketed across all sessions over the selected
 * window, mapped onto --color-chart-1..5 via chartUtils so the palette matches
 * in light + dark automatically. The usePulse buckets are reshaped into the
 * flat per-bucket rows ({t, <category>: n, …}) the AreaChart consumes.
 */
export default function PulseChart({
  series,
  minutes,
  onRange,
  compact = false,
}: PulseChartProps) {
  const buckets = series?.buckets ?? [];
  const totals = series?.totals ?? {
    events: 0,
    retries: 0,
    tokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  };
  const hasData = totals.events > 0 || totals.tokens > 0 || totals.cost > 0;
  // Pulse footer (US-???): the displayed "tokens" sum is dominated by
  // cache_read replays (typically 95–99% of the total) — showing the raw
  // sum reads as alarming inflation even though new work is tiny. Split
  // into `new` (cache_creation + input + output) and `cache` so both
  // signals are visible. See commit 125bde8 + the v4.7 pulse change.
  const newTokens = Math.max(0, totals.tokens - totals.cacheReadTokens);

  // Reshape the per-category bucket breakdown into flat rows keyed by the
  // display labels, with a date+time index label for the X axis. The format
  // prepends the locale's short month/day so a 24h or 7d window doesn't read
  // ambiguously when the start crosses midnight (e.g. `05/29 14:49`). 24h
  // clock so users with `hour12: true` system prefs don't see AM/PM mixed in.
  const data = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return buckets.map((b) => {
      const row: Record<string, number | string> = { t: fmt.format(b.t) };
      for (const c of CATEGORIES) row[c.label] = b.types?.[c.key] ?? 0;
      return row;
    });
  }, [buckets]);

  // Per-category totals for the footer summary; also which categories actually
  // carried activity in this window (drives the chart's plotted categories so
  // empty bands don't clutter the legend).
  const typeTotals = useMemo(() => {
    const acc: Record<PulseCategory, number> = {
      tool: 0,
      assistant: 0,
      prompt: 0,
      session: 0,
      other: 0,
    };
    for (const b of buckets)
      for (const c of CATEGORIES) acc[c.key] += b.types?.[c.key] ?? 0;
    return acc;
  }, [buckets]);

  const activeCategories = CATEGORIES.filter((c) => typeTotals[c.key] > 0);
  const categories = activeCategories.map((c) => c.label);
  const colors = activeCategories.map((c) => c.color);

  /* ───── US-103 wall logic ───── */
  const tier = useTier();
  const isFree = tier.tier === "free";
  // Initial state reads the module so re-mounting (HUD tab switch) restores
  // the latched walled state immediately — no flicker of unblurred chart
  // before the local useState catches up.
  const [walled, setWalledLocal] = useState(() => pulseSessionWalled);

  // Grace clock: starts the first time we see live data on a Free render,
  // resumes elapsed-aware on re-mounts. The timeout fires once across the
  // session because the module latches `pulseSessionWalled = true`.
  useEffect(() => {
    if (!isFree || walled || !hasData) return;
    if (pulseSessionStartedAt === null) pulseSessionStartedAt = Date.now();
    const elapsed = Date.now() - pulseSessionStartedAt;
    const remaining = Math.max(0, FREE_PULSE_GRACE_MS - elapsed);
    const t = window.setTimeout(() => {
      pulseSessionWalled = true;
      setWalledLocal(true);
    }, remaining);
    return () => window.clearTimeout(t);
  }, [isFree, walled, hasData]);

  // Premium-snap: clear the wall + reset the clock as soon as the tier
  // flips, so a paste-then-Apply in Settings ▸ License gives instant access.
  useEffect(() => {
    if (!isFree) {
      resetPulseSession();
      if (walled) setWalledLocal(false);
    }
  }, [isFree, walled]);

  return (
    <section
      className={
        "flex h-full flex-col " +
        (compact
          ? "bg-card px-3 py-3"
          : "rounded-xl border border-border bg-card p-4")
      }
    >
      {/* Compact (HUD) mode pulls the title + range selector up into the shared
          <HudTabHeader> toolbar (US-005), so the chart's own header only renders
          in the standalone panel — avoiding a duplicate "Pulse" label. */}
      {!compact && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Pulse</span>
            <span className="text-xs text-muted-foreground">
              throughput across sessions
            </span>
          </div>
          <PulseRange minutes={minutes} onRange={onRange} />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {hasData && categories.length > 0 ? (
          <AreaChart
            className={
              "h-full min-h-48 w-full " +
              (walled
                ? "pointer-events-none select-none [filter:blur(6px)]"
                : "")
            }
            data={data}
            index="t"
            categories={categories}
            colors={colors}
            type="stacked"
            showYAxis={!compact}
            startEndOnly={compact}
            valueFormatter={(v) => String(v)}
            yAxisWidth={40}
            // Smaller + monospaced X-axis ticks. The date+time label
            // (e.g. `05/29 14:49`) reads cleaner in mono since the digit
            // widths line up — and the smaller size keeps the start/end
            // labels from crowding when both edges carry the same width.
            xAxisTickClassName="font-mono text-[9px] tabular-nums"
          />
        ) : (
          <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">
            No activity in this window yet.
          </div>
        )}
        {/* US-103 wall: absolute over the chart container, vertically
            centered so it can't be scrolled past to peek at the blur.
            Same JSX shape as the Timeline upgrade overlay (US-102) so the
            two surfaces read as one upgrade story. */}
        {walled && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
            <div className="pointer-events-auto flex max-w-xs flex-col items-center gap-3 rounded-xl border border-border bg-card/95 px-6 py-5 text-center shadow-xl backdrop-blur-md">
              {/* Conan icon + lock badge — matches the Timeline upgrade
                  overlay so the two walls read as one brand moment. */}
              <div className="relative">
                <img
                  src={conanIcon}
                  alt="Conan"
                  className="size-10 rounded-md"
                />
                <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-border bg-card shadow-sm">
                  <Lock className="size-3 text-muted-foreground" />
                </span>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <div className="text-[13px] font-semibold leading-tight text-foreground">
                  Unlock live Pulse
                </div>
                <div className="text-[11px] leading-tight text-muted-foreground">
                  Conan Premium · {PREMIUM_PRICE} · lifetime
                </div>
              </div>
              <button
                type="button"
                onClick={openLicenseSettings}
                className="rounded-md bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Upgrade
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Summary footer + per-category legend swatches. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {activeCategories.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: `var(${c.varName})` }}
            />
            {typeTotals[c.key]} {c.label.toLowerCase()}
          </span>
        ))}
        <span
          className="inline-flex items-center gap-1.5"
          title={`${totals.tokens.toLocaleString()} tokens total (matches /usage); ${newTokens.toLocaleString()} new, ${totals.cacheReadTokens.toLocaleString()} replayed from prompt cache`}
        >
          {fmtTokens(newTokens)} new
          <span className="text-muted-foreground/60">·</span>
          {fmtTokens(totals.cacheReadTokens)} cache
        </span>
        {totals.retries > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-destructive" />
            {totals.retries} retries
          </span>
        )}
      </div>
    </section>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
