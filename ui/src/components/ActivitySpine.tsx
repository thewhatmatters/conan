import { useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

/** One sub-tick under a turn: a skill firing or tool call shown in hover detail. */
export interface SpineTick {
  kind: "skill" | "tool";
  label: string;
  id?: string;
  /** Measured position in the transcript's own scroll coordinate system. */
  position?: number;
  /** Live 0–1 offset inside the currently visible transcript viewport. */
  viewportOffset?: number;
}

/** One navigable turn and the activity associated with it. */
export interface SpineTurn {
  id: string;
  text: string;
  reply?: string;
  ticks: SpineTick[];
  /** Real provider transcript time (epoch ms), when available. */
  ts?: number | null;
  /** Measured position in the transcript's own scroll coordinate system. */
  position?: number;
  /** Live 0–1 offset inside the currently visible transcript viewport. */
  viewportOffset?: number;
}

/** Visible transcript window as 0–1 fractions of the full scroll height. */
export interface SpineViewport {
  top: number;
  height: number;
}

interface TurnBucket {
  first: SpineTurn;
  turns: SpineTurn[];
}

const MIN_RANGE_SPAN = 0.03;
const MIN_VISUAL_VIEWPORT = 0.3;
const VIEWPORTS_PER_RANGE = 1 / MIN_VISUAL_VIEWPORT;
const MAX_RANGES = 64;

function formatStart(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function firstReplyLine(reply: string | undefined): string | null {
  if (!reply) return null;
  return reply.split("\n").find((line) => line.trim())?.trim() ?? null;
}

function bucketTurns(turns: SpineTurn[]): TurnBucket[] {
  // Ranges already limit density. Keeping one mark per real turn preserves
  // the critical contract: a hovered mark names exactly the DOM message at
  // that scroll position, never an index-grouped prompt from elsewhere.
  return turns.map((turn) => ({ first: turn, turns: [turn] }));
}

function rangeTime(
  turns: SpineTurn[],
  fraction: number,
  fallback?: number | null,
): number | null {
  if (turns.length === 0) return fallback ?? null;
  const index = Math.min(
    turns.length - 1,
    Math.max(0, Math.floor(fraction * turns.length)),
  );
  for (let distance = 0; distance < turns.length; distance += 1) {
    const after = turns[index + distance]?.ts;
    if (after != null) return after;
    const before = turns[index - distance]?.ts;
    if (before != null) return before;
  }
  return fallback ?? null;
}

export default function ActivitySpine({
  turns,
  onJump,
  onViewportChange,
  viewport,
}: {
  turns: SpineTurn[];
  onJump: (id: string) => void;
  /** Scroll the transcript to a normalized top position (0–1). */
  onViewportChange?: (top: number) => void;
  viewport?: SpineViewport | null;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ clientY: number; top: number } | null>(null);
  const rangeReleaseRef = useRef<number | null>(null);
  // A timeline interaction pins its current segment so ticks never re-layout
  // halfway through a click animation or drag.
  const [pinnedRange, setPinnedRange] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const pinRangeDuringMotion = (range: number, duration = 200) => {
    if (rangeReleaseRef.current != null)
      window.clearTimeout(rangeReleaseRef.current);
    setPinnedRange(range);
    rangeReleaseRef.current = window.setTimeout(() => {
      setPinnedRange(null);
      rangeReleaseRef.current = null;
    }, duration);
  };

  if (turns.length === 0) {
    return (
      <nav
        aria-label="Conversation activity"
        className="flex w-16 shrink-0"
      />
    );
  }

  const buckets = bucketTurns(turns);
  const viewportTop = Math.max(0, Math.min(viewport?.top ?? 0, 1));
  const viewportHeight = Math.max(0.001, Math.min(viewport?.height ?? 1, 1));
  const desiredRangeSpan = Math.max(
    MIN_RANGE_SPAN,
    viewportHeight * VIEWPORTS_PER_RANGE,
  );
  const rangeSpan = Math.min(1, desiredRangeSpan);
  const maxViewportTop = Math.max(0, 1 - viewportHeight);
  const idealRangeStep = Math.max(0.001, rangeSpan - viewportHeight);
  const rangeCount =
    rangeSpan >= 1
      ? 1
      : Math.min(
          MAX_RANGES,
          Math.ceil(maxViewportTop / idealRangeStep) + 1,
        );
  // Adjacent ranges overlap by exactly one viewport. That guarantees the
  // current visible chat always fits wholly inside one range; the blue
  // capsule is never clipped or padded at a range boundary.
  const rangeStep =
    rangeCount <= 1 ? 0 : (1 - rangeSpan) / (rangeCount - 1);
  const derivedRange = Math.min(
    rangeCount - 1,
    rangeStep === 0 ? 0 : Math.floor(viewportTop / rangeStep),
  );
  const activeRange = Math.max(
    0,
    Math.min(pinnedRange ?? derivedRange, rangeCount - 1),
  );
  const rangeStart = activeRange * rangeStep;
  const rangeEnd = Math.min(1, rangeStart + rangeSpan);
  const localViewportTop = Math.max(
    0,
    Math.min(
      (viewportTop - rangeStart) / rangeSpan,
      1 - Math.min(1, viewportHeight / rangeSpan),
    ),
  );
  const localViewportHeight = Math.min(1, viewportHeight / rangeSpan);
  const maxLocalViewportTop = Math.max(0, 1 - localViewportHeight);
  const rangeBuckets = buckets.filter((bucket) => {
    const position = bucket.first.position;
    return position == null || (position >= rangeStart && position < rangeEnd);
  });
  const tickPosition = new Map(
    rangeBuckets.map((bucket, index) => [
      bucket.first.id,
      bucket.first.position == null
        ? rangeBuckets.length <= 1
          ? 0.08
          : index / (rangeBuckets.length - 1)
        : Math.max(
            0,
            Math.min(
              1,
              (bucket.first.position - rangeStart) / rangeSpan,
            ),
          ),
    ]),
  );
  // Activity rows can cross a range boundary independently of their parent
  // prompt (for example after a very long assistant response). Filter them by
  // their own measured positions so visible tools are never dropped merely
  // because the initiating user turn belongs to the previous range.
  const rangeActivities = turns.flatMap((turn) =>
    turn.ticks.flatMap((tick, tickIndex) => {
      const position =
        tick.position ??
        turn.position ??
        rangeStart + 0.008 * Math.min(tickIndex + 1, 4) * rangeSpan;
      return position >= rangeStart && position < rangeEnd
        ? [{ tick, tickIndex, position, turnId: turn.id }]
        : [];
    }),
  );
  // The selected range is sized to roughly 3⅓ transcript viewports, making
  // the real viewport about 30% of the rail without any non-linear remapping.
  // Ticks therefore remain stationary; only this pill moves.
  const visualViewportTop = localViewportTop;
  const visualViewportHeight = localViewportHeight;

  const scrollFromPointer = (clientY: number, offsetPx: number) => {
    const track = trackRef.current;
    if (!track || !onViewportChange) return;
    const rect = track.getBoundingClientRect();
    const localTop =
      (clientY - rect.top - offsetPx) / Math.max(rect.height, 1);
    onViewportChange(
      rangeStart +
        Math.max(0, Math.min(localTop, maxLocalViewportTop)) * rangeSpan,
    );
  };

  const nudgeViewport = (nextLocalTop: number) => {
    const bounded = Math.max(0, Math.min(nextLocalTop, maxLocalViewportTop));
    onViewportChange?.(rangeStart + bounded * rangeSpan);
  };
  const goToRange = (nextRange: number) => {
    const bounded = Math.max(0, Math.min(nextRange, rangeCount - 1));
    pinRangeDuringMotion(bounded, 50);
    // Land just inside the requested range. Scroll positions are pixel-rounded,
    // so targeting the exact fractional boundary can settle a hair below it;
    // once the temporary pin releases, `floor(viewportTop / rangeStep)` would
    // then snap back to the preceding range.
    const boundaryInset = bounded === 0 ? 0 : Math.min(0.0005, rangeStep / 10);
    onViewportChange?.(
      Math.min(maxViewportTop, bounded * rangeStep + boundaryInset),
    );
  };

  return (
    <nav
      aria-label="Conversation activity"
      className="flex w-16 shrink-0 items-center py-4"
    >
      <TooltipProvider delayDuration={150}>
        <div className="m-auto flex flex-col items-center gap-1.5">
          <div className="relative h-[clamp(360px,65vh,620px)] w-8">
            <div
              ref={trackRef}
              className="absolute inset-0 cursor-pointer"
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                pinRangeDuringMotion(activeRange, 50);
                const track = trackRef.current;
                if (!track) return;
                scrollFromPointer(
                  event.clientY,
                  (track.clientHeight * visualViewportHeight) / 2,
                );
              }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border"
              />
              <div
                role="scrollbar"
                tabIndex={0}
                aria-label="Scroll conversation"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(localViewportTop * 100)}
                className={`group absolute left-1/2 z-20 w-7 -translate-x-1/2 cursor-grab touch-none rounded-full border border-chart-2/40 bg-chart-2/15 text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing ${
                  isDragging
                    ? ""
                    : "transition-[top,height] duration-150 ease-out"
                }`}
                style={{
                  top: `${visualViewportTop * 100}%`,
                  height: `${visualViewportHeight * 100}%`,
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (rangeReleaseRef.current != null)
                    window.clearTimeout(rangeReleaseRef.current);
                  setPinnedRange(activeRange);
                  setIsDragging(true);
                  const handle = event.currentTarget;
                  dragStartRef.current = {
                    clientY: event.clientY,
                    top: viewportTop,
                  };
                  handle.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId))
                    return;
                  const start = dragStartRef.current;
                  const track = trackRef.current;
                  if (!start || !track || !onViewportChange) return;
                  const delta =
                    (event.clientY - start.clientY) /
                    Math.max(track.clientHeight, 1);
                  onViewportChange(
                    Math.max(
                      0,
                      Math.min(start.top + delta * rangeSpan, 1 - viewportHeight),
                    ),
                  );
                }}
                onPointerUp={() => {
                  dragStartRef.current = null;
                  setIsDragging(false);
                  setPinnedRange(null);
                }}
                onPointerCancel={() => {
                  dragStartRef.current = null;
                  setIsDragging(false);
                  setPinnedRange(null);
                }}
                onKeyDown={(event) => {
                  const lineStep = 0.025;
                  const pageStep = Math.max(localViewportHeight * 0.8, 0.1);
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    nudgeViewport(localViewportTop - lineStep);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    nudgeViewport(localViewportTop + lineStep);
                  } else if (event.key === "PageUp") {
                    event.preventDefault();
                    nudgeViewport(localViewportTop - pageStep);
                  } else if (event.key === "PageDown") {
                    event.preventDefault();
                    nudgeViewport(localViewportTop + pageStep);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    nudgeViewport(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    nudgeViewport(maxLocalViewportTop);
                  }
                }}
              >
                <button
                  type="button"
                  aria-label="Previous conversation range"
                  disabled={activeRange === 0}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => goToRange(activeRange - 1)}
                  className="absolute left-1/2 top-1 flex size-5 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100 group-hover:opacity-100 disabled:cursor-default disabled:opacity-20"
                >
                  <ChevronUp className="size-3" />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Conversation time range"
                    onPointerDown={(event) => event.stopPropagation()}
                    className="absolute left-1/2 top-1/2 h-5 min-w-7 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full bg-card/90 px-1 text-center text-[10px] tabular-nums opacity-0 shadow-sm outline-none transition-opacity hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {activeRange + 1}/{rangeCount}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="left"
                    align="center"
                    sideOffset={8}
                    className="min-w-28"
                  >
                    {Array.from({ length: rangeCount }, (_, index) => {
                      const ts = rangeTime(turns, index * rangeStep);
                      const label =
                        ts == null
                          ? `Part ${index + 1}/${rangeCount}`
                          : `${formatStart(ts)} · ${index + 1}/${rangeCount}`;
                      return (
                        <DropdownMenuItem
                          key={index}
                          className="cursor-pointer text-xs tabular-nums"
                          onSelect={() => goToRange(index)}
                        >
                          <span className="flex-1">{label}</span>
                          {index === activeRange && (
                            <span aria-hidden className="text-muted-foreground">
                              ✓
                            </span>
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  aria-label="Next conversation range"
                  disabled={activeRange === rangeCount - 1}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => goToRange(activeRange + 1)}
                  className="absolute bottom-1 left-1/2 flex size-5 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100 group-hover:opacity-100 disabled:cursor-default disabled:opacity-20"
                >
                  <ChevronDown className="size-3" />
                </button>
              </div>

              {rangeActivities.map(
                ({ tick, tickIndex, position, turnId }) => {
                  const localActivityPosition = Math.max(
                    0,
                    Math.min(1, (position - rangeStart) / rangeSpan),
                  );
                  return (
                    <span
                      key={`${turnId}-${tick.kind}-${tick.id ?? tick.label}-${tickIndex}`}
                      aria-hidden
                      className={`pointer-events-none absolute left-1/2 z-[25] block w-px -translate-x-1/2 transition-[top,height] duration-150 ease-out ${
                        tick.kind === "skill"
                          ? "bg-chart-4"
                          : "bg-chart-1"
                      }`}
                      style={{
                        top: `${localActivityPosition * 100}%`,
                        height: `${Math.min(0.03, 1 - localActivityPosition) * 100}%`,
                      }}
                    />
                  );
                },
              )}

              {rangeBuckets.map((bucket, index) => {
                const localPosition =
                  tickPosition.get(bucket.first.id) ??
                  (rangeBuckets.length <= 1
                    ? 0.08
                    : index / (rangeBuckets.length - 1));
                const inViewport =
                  bucket.first.viewportOffset != null &&
                  bucket.first.viewportOffset >= 0 &&
                  bucket.first.viewportOffset <= 1;
                const reply = firstReplyLine(bucket.first.reply);

                return (
                  <div key={bucket.first.id}>
                    <Tooltip>
                      <TooltipTrigger
                        onClick={() => {
                          pinRangeDuringMotion(activeRange);
                          onJump(bucket.first.id);
                        }}
                        aria-label={`Jump to prompt ${index + 1}`}
                        className={`absolute left-1/2 z-30 h-4 w-8 -translate-x-1/2 -translate-y-1/2 cursor-pointer bg-transparent transition-[top] duration-150 ease-out after:absolute after:right-[calc(50%-6px)] after:top-1/2 after:h-px after:w-3 after:-translate-y-1/2 after:rounded-full after:transition-[width,background-color] after:duration-150 hover:after:w-6 hover:after:bg-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                          inViewport
                            ? "after:bg-muted-foreground/70"
                            : "after:bg-muted-foreground/40"
                        }`}
                        style={{ top: `${localPosition * 100}%` }}
                      />
                      <TooltipContent
                        side="left"
                        sideOffset={10}
                        className="w-72 max-w-72 rounded-lg border border-border border-r-2 border-r-chart-1 bg-popover px-3 py-2.5 text-popover-foreground shadow-md"
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-1 size-2.5 shrink-0 rounded-full bg-foreground" />
                          <div className="min-w-0">
                            <p className="line-clamp-2 whitespace-pre-wrap text-[13px] font-medium leading-snug">
                              {bucket.first.text}
                            </p>
                            {reply && (
                              <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
                                {reply}
                              </p>
                            )}
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>

                  </div>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            className="cursor-pointer text-[10px] tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              pinRangeDuringMotion(rangeCount - 1, 50);
              onViewportChange?.(1);
            }}
          >
            Present
          </button>
        </div>
      </TooltipProvider>
    </nav>
  );
}
