import { useEffect, useRef, useState } from "react";
import type { PulseSeries } from "../hooks/usePulse.ts";

type Range = { label: string; minutes: number };
const RANGES: Range[] = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

type Metric = "tokens" | "cost";

interface PulseChartProps {
  series: PulseSeries | null;
  minutes: number;
  onRange: (minutes: number) => void;
}

const H = 160; // plot height in px
const PAD_BOTTOM = 18; // room for the retry tick rail

/**
 * US-020: the Pulse / throughput chart. Bars are events-per-minute across all
 * sessions; the overlaid line is token (or cost) burn over the same window;
 * red ticks on the bottom rail mark buckets that contained an api_retry. This
 * is time-series — distinct from the snapshot hero cards (US-010). Semantic
 * tokens only; geometry is measured so the SVG stays crisp at any width.
 */
export default function PulseChart({ series, minutes, onRange }: PulseChartProps) {
  const [metric, setMetric] = useState<Metric>("tokens");
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

  const maxEvents = Math.max(1, ...buckets.map((b) => b.events));
  const lineVals = buckets.map((b) => (metric === "tokens" ? b.tokens : b.cost));
  const maxLine = Math.max(0, ...lineVals);

  const plotH = H - PAD_BOTTOM;
  const n = Math.max(1, buckets.length);
  const bw = width / n;
  // Bar geometry.
  const bars = buckets.map((b, i) => {
    const h = (b.events / maxEvents) * (plotH - 4);
    return {
      x: i * bw + bw * 0.15,
      w: Math.max(1, bw * 0.7),
      y: plotH - h,
      h,
      retry: b.retries > 0,
    };
  });
  // Line points (centered in each bucket); only drawn when there's a scale.
  const linePts =
    maxLine > 0
      ? buckets
          .map((b, i) => {
            const v = metric === "tokens" ? b.tokens : b.cost;
            const x = i * bw + bw / 2;
            const y = plotH - (v / maxLine) * (plotH - 8);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">Pulse</span>
          <span className="text-xs text-muted-foreground">
            throughput across sessions
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Metric toggle: token burn vs. cost burn on the overlay line. */}
          <div className="flex rounded-md border border-border bg-background p-0.5 text-xs">
            {(["tokens", "cost"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={
                  "rounded px-2 py-0.5 capitalize " +
                  (metric === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted")
                }
              >
                {m}
              </button>
            ))}
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
      </div>

      <div ref={wrapRef} className="relative w-full">
        {hasData ? (
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            className="block"
            role="img"
            aria-label="Activity and token/cost over time"
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
            {/* Events-per-bucket bars. */}
            {bars.map((b, i) => (
              <rect
                key={i}
                x={b.x}
                y={b.y}
                width={b.w}
                height={Math.max(0, b.h)}
                rx="1"
                className="fill-primary/30"
              />
            ))}
            {/* Token / cost overlay line. */}
            {linePts && (
              <polyline
                points={linePts}
                fill="none"
                className="stroke-primary"
                strokeWidth="1.75"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {/* api_retry rail: a red tick under each bucket that retried. */}
            {bars.map((b, i) =>
              b.retry ? (
                <rect
                  key={`r${i}`}
                  x={b.x}
                  y={plotH + 4}
                  width={b.w}
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
          <div className="flex h-[160px] items-center justify-center text-xs text-muted-foreground">
            No activity in this window yet.
          </div>
        )}
      </div>

      {/* Summary footer + legend. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-primary/30" />
          {totals.events} events
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-primary" />
          {metric === "tokens"
            ? `${fmtTokens(totals.tokens)} tokens`
            : `$${totals.cost.toFixed(2)}`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-destructive" />
          {totals.retries} retries
        </span>
      </div>
    </section>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
