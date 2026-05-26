import { useEffect, useMemo, useRef, useState } from "react";
import type { PulseSeries, PulseCategory } from "../hooks/usePulse.ts";

type Range = { label: string; minutes: number };
const RANGES: Range[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

/**
 * Activity categories the area stacks by (bottom → top), mapped 1:1 onto the
 * --color-chart-1..5 theme tokens (US-005). Mirrors PULSE_CATEGORIES on the
 * backend (src/pulse/index.ts).
 */
const CATEGORIES: { key: PulseCategory; label: string; varName: string }[] = [
  { key: "tool", label: "Tools", varName: "--color-chart-1" },
  { key: "assistant", label: "Assistant", varName: "--color-chart-2" },
  { key: "prompt", label: "Prompts", varName: "--color-chart-3" },
  { key: "session", label: "Session", varName: "--color-chart-4" },
  { key: "other", label: "Other", varName: "--color-chart-5" },
];

interface PulseChartProps {
  series: PulseSeries | null;
  minutes: number;
  onRange: (minutes: number) => void;
  /**
   * US-004: render as a flush bottom strip inside the Dock (shorter plot, no
   * card chrome) instead of the standalone Overview panel.
   */
  compact?: boolean;
}

const PAD_BOTTOM = 18; // room for the retry tick rail

/**
 * US-016: the Pulse / throughput chart — a hand-rolled SVG stacked-area
 * time-series. Each band is an activity category (tool/assistant/prompt/...)
 * bucketed across all sessions over the selected window; the overlaid line is
 * token burn over the same window; red ticks on the bottom rail mark buckets
 * that contained an api_retry. Distinct from the snapshot hero cards (US-010).
 * Zero charting deps, semantic/chart tokens only; geometry is measured so the
 * SVG stays crisp at any width.
 *
 * US-004: lives pinned to the bottom of the Dock column (`compact`) and always
 * plots tokens — the tokens↔cost toggle was removed (cost is meaningless on a
 * token-based plan), though the underlying pulse payload still carries `cost`.
 */
export default function PulseChart({
  series,
  minutes,
  onRange,
  compact = false,
}: PulseChartProps) {
  const H = compact ? 96 : 160; // plot height in px
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const buckets = series?.buckets ?? [];
  const totals = series?.totals ?? { events: 0, retries: 0, tokens: 0, cost: 0 };
  const hasData = totals.events > 0 || totals.tokens > 0 || totals.cost > 0;

  const plotH = H - PAD_BOTTOM;
  const n = Math.max(1, buckets.length);
  const bw = width / n;

  // Tallest total-activity bucket sets the area's vertical scale.
  const maxStack = Math.max(
    1,
    ...buckets.map((b) => b.events),
  );

  // Build one filled <polygon> per category by walking the running stack base
  // bucket-by-bucket: the band's top edge is left→right, its bottom edge is the
  // previous bands' cumulative total drawn right→left to close the shape.
  const bandPolys = useMemo(() => {
    const xAt = (i: number) => i * bw + bw / 2;
    const yAt = (v: number) => plotH - (v / maxStack) * (plotH - 6);
    const running = buckets.map(() => 0); // cumulative height below current band

    return CATEGORIES.map(({ key, varName }) => {
      const tops: string[] = [];
      const bottoms: string[] = [];
      let any = false;
      buckets.forEach((b, i) => {
        const base = running[i] ?? 0;
        const top = base + (b.types?.[key] ?? 0);
        if (b.types?.[key]) any = true;
        const x = xAt(i).toFixed(1);
        tops.push(`${x},${yAt(top).toFixed(1)}`);
        bottoms.push(`${x},${yAt(base).toFixed(1)}`);
        running[i] = top;
      });
      // Anchor the band to the baseline at both ends so single-point series
      // (n===1) and edges still render as a visible shape.
      const points = [...tops, ...bottoms.reverse()].join(" ");
      return { key, varName, points, any };
    });
  }, [buckets, bw, plotH, maxStack]);

  // Token overlay line, on its own scale.
  const lineVals = buckets.map((b) => b.tokens);
  const maxLine = Math.max(0, ...lineVals);
  const linePts =
    maxLine > 0
      ? buckets
          .map((b, i) => {
            const v = b.tokens;
            const x = i * bw + bw / 2;
            const y = plotH - (v / maxLine) * (plotH - 8);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";

  // Per-category totals for the legend.
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

  return (
    <section
      className={
        compact
          ? "border-t border-border bg-card px-3 py-2"
          : "rounded-xl border border-border bg-card p-4"
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

      <div ref={wrapRef} className="relative w-full">
        {hasData ? (
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            className="block"
            role="img"
            aria-label="Activity by type and token/cost over time"
          >
            {/* Baseline. */}
            <line
              x1="0"
              y1={plotH}
              x2={width}
              y2={plotH}
              className="stroke-border"
              strokeWidth="1"
            />
            {/* Stacked activity bands, one filled polygon per category. */}
            {bandPolys.map((band) =>
              band.any ? (
                <polygon
                  key={band.key}
                  points={band.points}
                  fill={`var(${band.varName})`}
                  fillOpacity={0.78}
                  stroke={`var(${band.varName})`}
                  strokeWidth="1"
                  strokeLinejoin="round"
                />
              ) : null,
            )}
            {/* Token / cost overlay line. */}
            {linePts && (
              <polyline
                points={linePts}
                fill="none"
                className="stroke-foreground"
                strokeOpacity={0.55}
                strokeWidth="1.5"
                strokeDasharray="3 2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {/* api_retry rail: a red tick under each bucket that retried. */}
            {buckets.map((b, i) =>
              b.retries > 0 ? (
                <rect
                  key={`r${i}`}
                  x={i * bw + bw * 0.15}
                  y={plotH + 4}
                  width={Math.max(1, bw * 0.7)}
                  height="4"
                  rx="1"
                  className="fill-destructive"
                >
                  <title>api_retry</title>
                </rect>
              ) : null,
            )}
          </svg>
        ) : (
          <div
            style={{ height: H }}
            className="flex items-center justify-center text-xs text-muted-foreground"
          >
            No activity in this window yet.
          </div>
        )}
      </div>

      {/* Summary footer + per-category legend. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {CATEGORIES.filter((c) => typeTotals[c.key] > 0).map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: `var(${c.varName})` }}
            />
            {typeTotals[c.key]} {c.label.toLowerCase()}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-3 border-t border-dashed border-foreground/55" />
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
