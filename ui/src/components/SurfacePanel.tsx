import { useCallback, useRef, useState } from "react";
import { FileDiff, FolderTree, Globe, Plus, SquareTerminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import FileExplorer from "./FileExplorer.tsx";
import DiffSurface from "./DiffSurface.tsx";
import TerminalSurface from "./TerminalSurface.tsx";
import BrowserSurface from "./BrowserSurface.tsx";

/**
 * Right-side surface panel (Conan Surfaces US-001/US-002, T3 parity): a
 * per-thread panel beside the transcript that opens Browser / Terminal /
 * Files / Diff as internal windows — up to TWO side by side (2-up max, the
 * ratified v1 decision). This shell ships the T3-style "Open a surface" card
 * grid, the side-by-side split, and a draggable splitter on the panel's left
 * edge. Files (US-003) mounts the real FileExplorer pegged to the thread's
 * project cwd; Diff (US-005) reviews the thread's uncommitted changes;
 * Terminal (US-006) runs a real workspace shell (close = kill, ratified);
 * Browser (US-007) previews local apps in an iframe, honest about framing
 * limits via the gateway header probe.
 *
 * Width state lives in ChatPane (per-thread, in-memory) because the composer
 * needs it to keep its centering axis matched to the transcript's while the
 * panel is open (the F8 alignment contract). Window state lives here — the
 * per-thread ChatPane keeps its panel mounted across thread switches.
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
/** 2-up max — Randy's ratified v1 decision. Do not grow without a new one. */
export const SURFACE_MAX_WINDOWS = 2;

/** One open internal window. The id keeps React keys stable when the same
 * surface type is open in both slots (no state bleed between them). */
type SurfaceWindow = { id: number; kind: SurfaceKind };

function SurfaceCardGrid({
  columns,
  onSelect,
}: {
  columns: 1 | 2;
  onSelect: (kind: SurfaceKind) => void;
}) {
  return (
    <div
      className={
        "grid w-full gap-2 " +
        (columns === 2 ? "max-w-sm grid-cols-2" : "max-w-52 grid-cols-1")
      }
    >
      {SURFACES.map(({ kind, name, blurb, Icon }) => (
        <button
          key={kind}
          type="button"
          onClick={() => onSelect(kind)}
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
  );
}

/** The last path segment of a directory, for surface window titles. */
function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export default function SurfacePanel({
  width,
  onWidthChange,
  onClose,
  token,
  cwd,
  touchedPaths,
}: {
  /** Current panel width in px (owned by ChatPane, per-thread). */
  width: number;
  onWidthChange: (width: number) => void;
  /** Close the whole surfaces panel (owned by ChatPane, per-thread). */
  onClose: () => void;
  /** Gateway auth token (null until /api/config resolves) — surfaces fetch
   *  through the same authed routes. */
  token: string | null;
  /** The thread's project cwd; Files (and later Terminal/Diff) peg to it. */
  cwd: string | null;
  /** Files this thread's edit tools touched (US-005) — the Diff surface's
   *  path set, extracted from the transcript by ChatPane. */
  touchedPaths: string[];
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Open internal windows, left to right (US-002: up to SURFACE_MAX_WINDOWS).
  const [windows, setWindows] = useState<SurfaceWindow[]>([]);
  // Second-slot picker: the '+' affordance opens the card grid in the empty
  // slot instead of replacing the existing window.
  const [adding, setAdding] = useState(false);
  const nextWindowId = useRef(0);
  const [dragging, setDragging] = useState(false);

  const openWindow = useCallback((kind: SurfaceKind) => {
    setWindows((ws) =>
      ws.length >= SURFACE_MAX_WINDOWS ? ws : [...ws, { id: nextWindowId.current++, kind }],
    );
    setAdding(false);
  }, []);

  const closeWindow = useCallback((id: number) => {
    setWindows((ws) => ws.filter((w) => w.id !== id));
  }, []);

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

      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-3">
        <span className="truncate text-[11px] font-medium text-muted-foreground">
          Surfaces
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {windows.length === 1 && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              aria-label="Open another surface"
              title="Open another surface"
              className="inline-flex cursor-pointer items-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close surfaces panel"
            className="inline-flex cursor-pointer items-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {windows.length === 0 ? (
        /* T3-style empty state: "Open a surface" + 2x2 card grid. */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6">
          <h2 className="text-sm font-medium text-foreground">Open a surface</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
          <div className="mt-4 flex w-full justify-center">
            <SurfaceCardGrid columns={2} onSelect={openWindow} />
          </div>
        </div>
      ) : (
        /* Internal windows side by side (2-up max), each with its own h-9
           header + close. Closing one gives its space to the other via
           flex-1. */
        <div className="flex min-h-0 min-w-0 flex-1">
          {windows.map((w, i) => {
            const meta = SURFACES.find((s) => s.kind === w.kind)!;
            // Files pegs to the thread's cwd — its window is titled by the
            // workspace (the cwd basename), not the generic surface name.
            const title = w.kind === "files" && cwd ? basename(cwd) : meta.name;
            return (
              <div
                key={w.id}
                className={
                  "flex min-h-0 min-w-0 flex-1 flex-col" +
                  (i > 0 ? " border-l border-border" : "")
                }
              >
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
                  <meta.Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span
                    className="truncate text-[11px] text-muted-foreground"
                    title={w.kind === "files" ? (cwd ?? undefined) : undefined}
                  >
                    {title}
                  </span>
                  <div className="ml-auto flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => closeWindow(w.id)}
                      aria-label={`Close ${meta.name}`}
                      className="inline-flex cursor-pointer items-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </div>
                {w.kind === "files" ? (
                  <div className="min-h-0 flex-1">
                    <FileExplorer token={token ?? ""} cwd={cwd} />
                  </div>
                ) : w.kind === "diff" ? (
                  <div className="min-h-0 flex-1">
                    <DiffSurface token={token} cwd={cwd} touchedPaths={touchedPaths} />
                  </div>
                ) : w.kind === "terminal" ? (
                  <div className="min-h-0 flex-1">
                    <TerminalSurface token={token} cwd={cwd} />
                  </div>
                ) : (
                  <div className="min-h-0 flex-1">
                    <BrowserSurface token={token} />
                  </div>
                )}
              </div>
            );
          })}
          {adding && windows.length < SURFACE_MAX_WINDOWS && (
            /* Second-slot picker: the card grid in the empty slot. */
            <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
                <span className="truncate text-[11px] text-muted-foreground">
                  Open another surface
                </span>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  aria-label="Cancel opening another surface"
                  className="ml-auto inline-flex cursor-pointer items-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4">
                <SurfaceCardGrid columns={1} onSelect={openWindow} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
