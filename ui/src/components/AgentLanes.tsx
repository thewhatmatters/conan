import { useEffect, useMemo, useState } from "react";
import type { TimelineRow } from "./Timeline.tsx";
import { fmtDuration, fmtTokens } from "./Widgets.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";

export type AgentRow = Extract<TimelineRow, { kind: "agent" }>;

interface AgentLanesProps {
  rows: AgentRow[];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** DevTools-network-style waterfall of subagent spawns — one lane per bar,
 *  positioned/widthed against a shared time axis spanning the session's
 *  earliest spawn to its latest activity (or "now" while a bar is still
 *  running). No SVG/npm chart dep — absolutely-positioned divs, matching
 *  the project's existing hand-rolled-chart precedent. Wraps its own
 *  TooltipProvider so it works standalone regardless of where it's mounted
 *  (Timeline's own provider only wraps the classic row-list branch). */
export default function AgentLanes({ rows }: AgentLanesProps) {
  const hasOpenBar = rows.some((r) => r.endedAt == null);
  // Re-render every second so a still-running bar's width keeps growing.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasOpenBar) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasOpenBar]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.startedAt - b.startedAt),
    [rows],
  );

  if (sorted.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
        <span className="text-sm text-muted-foreground">
          No subagent spawns yet in this session.
        </span>
      </div>
    );
  }

  const now = Date.now();
  const rangeStart = Math.min(...sorted.map((r) => r.startedAt));
  const rangeEnd = Math.max(now, ...sorted.map((r) => r.endedAt ?? now));
  // Floor keeps a single-instant bar from dividing by zero.
  const span = Math.max(rangeEnd - rangeStart, 1000);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
        {sorted.map((row) => {
          const end = row.endedAt ?? now;
          const leftPct = ((row.startedAt - rangeStart) / span) * 100;
          const widthPct = Math.max(
            ((end - row.startedAt) / span) * 100,
            0.6,
          );
          const isRunning = row.endedAt == null;
          const label = `${row.agentType ?? "agent"} · ${row.description ?? ""}`;

          return (
            <div key={row.toolUseId} className="flex flex-col gap-1">
              <span className="truncate text-[11px] text-foreground">
                {truncate(label, 120)}
              </span>
              <div className="relative h-4 w-full rounded bg-muted/30">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={
                        "absolute top-0 h-4 min-w-[3px] cursor-help rounded " +
                        (isRunning
                          ? "animate-pulse bg-gradient-to-r from-chart-2 to-chart-2/40"
                          : "bg-chart-2")
                      }
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="flex flex-col gap-0.5 text-left">
                      <span className="font-semibold">
                        {row.agentType ?? "agent"}
                      </span>
                      {row.model && <span>model: {row.model}</span>}
                      {row.tools && <span>tools: {row.tools}</span>}
                      {row.description && (
                        <span>{truncate(row.description, 160)}</span>
                      )}
                      <span>
                        {isRunning
                          ? "running…"
                          : `duration: ${fmtDuration(end - row.startedAt)}`}
                      </span>
                      {!isRunning && row.tokens != null && (
                        <span>tokens: {fmtTokens(row.tokens)}</span>
                      )}
                      {!isRunning && row.toolCallCount != null && (
                        <span>tool calls: {row.toolCallCount}</span>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
