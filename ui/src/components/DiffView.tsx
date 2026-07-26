import { cn } from "../lib/utils.ts";
import type { FileDiff } from "../lib/diff.ts";

/**
 * The shared red/green patch renderer (US-021, extracted for the Diff surface
 * in Conan Surfaces US-005): red/green +/− rows in a bounded scroller, hunks
 * separated by a ⋯ row. Rendered inside expanded file-edit tool cards in the
 * transcript AND inside the Diff surface's per-file rows — one diff style,
 * never forked.
 */

/** `+N −M` line counts for a file diff (collapsed header + degraded
 *  summary). Additions ride the emerald status green (the Onboarding/MCP
 *  precedent — there's no semantic "success" token); removals the
 *  destructive token. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

/** Cap on rendered patch rows — a Write of a whole large file stays scrollable
 *  without mounting thousands of DOM nodes. */
export const MAX_DIFF_ROWS = 600;

/** The inline patch (US-021): red/green +/− rows in a bounded scroller,
 *  MultiEdit hunks separated by a ⋯ row. No modal, no side panel. `header`
 *  hides the Diff/path/stat caption where the surrounding row already shows
 *  it (the Diff surface's file rows). */
export function DiffView({ diff, header = true }: { diff: FileDiff; header?: boolean }) {
  const lines = diff.lines ?? [];
  const shown = lines.slice(0, MAX_DIFF_ROWS);
  return (
    <div>
      {header && (
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Diff
          </span>
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {diff.path}
          </span>
          <DiffStat added={diff.added} removed={diff.removed} />
        </div>
      )}
      <div className="max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/20 py-0.5 font-mono text-[11px] leading-5">
        {shown.map((l, i) =>
          l.type === "hunk" ? (
            <div key={i} className="border-y border-border/60 bg-muted/50 px-2 text-center text-muted-foreground">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "whitespace-pre px-2",
                l.type === "add" &&
                  "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
                l.type === "del" &&
                  "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-300",
                l.type === "ctx" && "text-muted-foreground",
              )}
            >
              <span className="select-none opacity-60">
                {l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}
              </span>
              {l.text}
            </div>
          ),
        )}
        {lines.length > MAX_DIFF_ROWS && (
          <div className="px-2 py-1 text-muted-foreground">
            … {lines.length - MAX_DIFF_ROWS} more lines
          </div>
        )}
      </div>
    </div>
  );
}
