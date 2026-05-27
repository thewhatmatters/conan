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
  // display labels, with a time-of-day index label for the X axis. Sub-hour
  // windows show seconds-free HH:MM; the same key set is the chart's categories.
  const data = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, {
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
      <div
        className={
          "flex flex-wrap items-center justify-between gap-3 " +
          (compact ? "mb-2" : "mb-3")
        }
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">Pulse</span>
          <span className="text-xs text-muted-foreground">
            {compact ? "all sessions" : "throughput across sessions"}
          </span>
        </div>
        {/* Window selector. */}
        <div className="flex rounded-md border border-border bg-background p-0.5 text-xs">
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              onClick={() => onRange(r.minutes)}
              className={
                "rounded px-2 py-0.5 " +
                (minutes === r.minutes
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted")
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

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
            showLegend
            startEndOnly={compact}
            valueFormatter={(v) => String(v)}
            yAxisWidth={40}
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
