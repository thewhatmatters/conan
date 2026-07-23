import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip.tsx";

/**
 * Activity spine (US-016) — a thin vertical rail beside the transcript that
 * fuses navigation with (next story) observability. One prominent tick per
 * user turn: hover previews the prompt, click jumps the transcript to that
 * turn. Ticks are evenly spaced rhythm marks, NOT pixel-proportional to
 * scroll position — the rail reads as the conversation's beat, not a
 * minimap. Skill/tool ticks cluster under their turn in US-017.
 */

/** One navigable turn — the transcript anchor id + the prompt text. */
export interface SpineTurn {
  id: string;
  text: string;
}

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
          {turns.map((t, i) => (
            <Tooltip key={t.id}>
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
          ))}
        </TooltipProvider>
      )}
    </div>
  );
}
