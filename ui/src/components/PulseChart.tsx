import { useMemo } from "react";
import type { PulseSeries, PulseCategory } from "../hooks/usePulse.ts";
import { AreaChart } from "./charts/AreaChart.tsx";
import type { AvailableChartColorsKeys } from "../lib/chartUtils.ts";

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
  const totals = series?.totals ?? { events: 0, retries: 0, tokens: 0, cost: 0 };
  const hasData = totals.events > 0 || totals.tokens > 0 || totals.cost > 0;

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

      <div className="min-h-0 flex-1">
        {hasData && categories.length > 0 ? (
          <AreaChart
            className="h-full min-h-48 w-full"
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
        <span className="inline-flex items-center gap-1.5">
          {fmtTokens(totals.tokens)} tokens
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
