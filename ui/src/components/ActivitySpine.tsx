import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Activity spine (US-016/US-017) — a thin vertical rail beside the transcript
 * that fuses navigation with observability. One prominent tick per user turn
 * (hover previews the prompt, click jumps the transcript there), with that
 * turn's activity clustered beneath it: accent ticks for skills fired
 * (session-scoped `{type:'skill-fired'}` WS rows), faint short ticks for tool
 * calls. Ticks are evenly spaced rhythm marks, NOT pixel-proportional to
 * scroll position — the rail reads as the conversation's beat, not a minimap.
 */

/** One sub-tick under a turn: a skill firing (accent) or a tool call (faint). */
export interface SpineTick {
  kind: "skill" | "tool";
  /** Tooltip text — the skill name, or the tool + its target. */
  label: string;
}

/** One navigable turn — the transcript anchor id, the prompt text, and the
 *  skills/tools that ran during it. */
export interface SpineTurn {
  id: string;
  text: string;
  ticks: SpineTick[];
}

/** Density guard: a busy turn shows at most this many sub-ticks; the rest
 *  collapse into a single "+N" indicator so the rail never spams. */
const MAX_CLUSTER_TICKS = 8;

export default function ActivitySpine({
  turns,
  onJump,
}: {
  turns: SpineTurn[];
  onJump: (id: string) => void;
}) {
  return (
    <div
      aria-label="Conversation activity"
      className="flex w-8 shrink-0 flex-col items-center gap-3 overflow-y-auto py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {turns.length > 0 && (
        <TooltipProvider delayDuration={150}>
          {turns.map((t, i) => {
            const visible = t.ticks.slice(0, MAX_CLUSTER_TICKS);
            const hidden = t.ticks.length - visible.length;
            return (
              <div
                key={t.id}
                className="flex shrink-0 flex-col items-center gap-1"
              >
                <Tooltip>
                  <TooltipTrigger
                    onClick={() => onJump(t.id)}
                    aria-label={`Jump to prompt ${i + 1}`}
                    className="h-1.5 w-4 shrink-0 rounded-full bg-muted-foreground/35 transition-colors hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <TooltipContent side="left" className="max-w-72">
                    <p className="line-clamp-6 whitespace-pre-wrap font-medium">
                      {t.text}
                    </p>
                  </TooltipContent>
                </Tooltip>
                {visible.map((tick, j) => (
                  <Tooltip key={j}>
                    <TooltipTrigger
                      onClick={() => onJump(t.id)}
                      aria-label={
                        tick.kind === "skill" ? "Skill fired" : "Tool call"
                      }
                      className={cn(
                        "shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        tick.kind === "skill"
                          ? "h-1 w-3 bg-primary/60 hover:bg-primary"
                          : "h-0.5 w-2 bg-muted-foreground/25 hover:bg-muted-foreground/60",
                      )}
                    />
                    <TooltipContent side="left" className="max-w-72">
                      <p className="line-clamp-3 break-all font-medium">
                        {tick.kind === "skill" ? `Skill · ${tick.label}` : tick.label}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ))}
                {hidden > 0 && (
                  <Tooltip>
                    <TooltipTrigger
                      onClick={() => onJump(t.id)}
                      className="text-[9px] font-medium tabular-nums leading-none text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none"
                    >
                      +{hidden}
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {hidden} more tool call{hidden === 1 ? "" : "s"} this turn
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </TooltipProvider>
      )}
    </div>
  );
}
