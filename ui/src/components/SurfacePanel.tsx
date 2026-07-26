import { useCallback, useRef, useState } from "react";
import { FileDiff, FolderTree, Globe, SquareTerminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Right-side surface panel (Conan Surfaces US-001, T3 parity): a per-thread
 * panel beside the transcript that opens Browser / Terminal / Files / Diff as
 * internal windows. This story ships the shell — the T3-style "Open a
 * surface" card grid, a stub window per surface, and a draggable splitter on
 * the panel's left edge. The real surfaces mount in later stories.
 *
 * Width state lives in ChatPane (per-thread, in-memory) because the composer
 * needs it to keep its centering axis matched to the transcript's while the
 * panel is open (the F8 alignment contract).
 */

export type SurfaceKind = "browser" | "terminal" | "files" | "diff";

const SURFACES: {
  kind: SurfaceKind;
  name: string;
  blurb: string;
  Icon: LucideIcon;
}[] = [
  { kind: "browser", name: "Browser", blurb: "Open a local app or URL.", Icon: Globe },
  { kind: "terminal", name: "Terminal", blurb: "Start a shell in this workspace.", Icon: SquareTerminal },
  { kind: "files", name: "Files", blurb: "Browse and read workspace files.", Icon: FolderTree },
  { kind: "diff", name: "Diff", blurb: "Review changes in this thread.", Icon: FileDiff },
];

export const SURFACE_PANEL_MIN_WIDTH = 320;
/** Max panel width as a fraction of the whole pane row. */
export const SURFACE_PANEL_MAX_FRACTION = 0.6;

export default function SurfacePanel({
  width,
  onWidthChange,
}: {
  /** Current panel width in px (owned by ChatPane, per-thread). */
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Which surface is open in the (single, v1) internal window. US-002 grows
  // this to two slots.
  const [surface, setSurface] = useState<SurfaceKind | null>(null);
  const [dragging, setDragging] = useState(false);

  // Splitter drag: pointer-captured horizontal resize against the pane row's
  // width (the panel's flex-row parent), clamped to [min, 60% of the row].
  const onSplitterPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const row = rootRef.current?.parentElement;
      if (!row) return;
      const rowWidth = row.getBoundingClientRect().width;
      const startX = e.clientX;
      const startWidth = width;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      setDragging(true);
      const onMove = (ev: PointerEvent) => {
        const next = Math.min(
          rowWidth * SURFACE_PANEL_MAX_FRACTION,
          Math.max(SURFACE_PANEL_MIN_WIDTH, startWidth + (startX - ev.clientX)),
        );
        onWidthChange(Math.round(next));
      };
      const onUp = () => {
        setDragging(false);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [width, onWidthChange],
  );

  const meta = surface ? SURFACES.find((s) => s.kind === surface) : null;

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width }}
    >
      {/* Splitter — straddles the panel's left border. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize surface panel"
        onPointerDown={onSplitterPointerDown}
        className={
          "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors " +
          (dragging ? "bg-primary/30" : "hover:bg-primary/20")
        }
      />

      {meta ? (
        /* Stub internal window — real surfaces land in later stories. */
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
            <meta.Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">{meta.name}</span>
            <button
              type="button"
              onClick={() => setSurface(null)}
              aria-label={`Close ${meta.name}`}
              className="ml-auto inline-flex cursor-pointer items-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
            The {meta.name} surface arrives in a later story.
          </div>
        </div>
      ) : (
        /* T3-style empty state: "Open a surface" + 2x2 card grid. */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6">
          <h2 className="text-sm font-medium text-foreground">Open a surface</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
          <div className="mt-4 grid w-full max-w-sm grid-cols-2 gap-2">
            {SURFACES.map(({ kind, name, blurb, Icon }) => (
              <button
                key={kind}
                type="button"
                onClick={() => setSurface(kind)}
                className="flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/50"
              >
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">{name}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {blurb}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
