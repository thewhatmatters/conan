import { useCallback, useEffect, useRef, useState } from "react";
import Terminal from "./Terminal.tsx";
import TaskChecklist from "./TaskChecklist.tsx";
import type { Theme } from "../hooks/useTheme.ts";
import type { TasksState } from "../hooks/useTasks.ts";

interface DockProps {
  token: string | null;
  theme: Theme;
  tasks: TasksState | null;
}

const MIN_W = 320;
const MAX_W = 900;
const TERMS_KEY = "conan.terms"; // sessionStorage: ordered list of tab tids

/** A single terminal tab — its `tid` keys an independent pty on the backend. */
interface TermTab {
  tid: string;
}

/** The active dock surface: a specific terminal tab (by tid) or the Tasks tab. */
type Active = { kind: "term"; tid: string } | { kind: "tasks" };

/**
 * Restore the terminal tab list from sessionStorage so a reload re-attaches to
 * the surviving ptys (US-017). Falls back to a single fresh tab, migrating the
 * legacy single-terminal `conan.tid` if present.
 */
function loadTerms(): TermTab[] {
  try {
    const raw = sessionStorage.getItem(TERMS_KEY);
    if (raw) {
      const ids = JSON.parse(raw) as string[];
      if (Array.isArray(ids) && ids.length) return ids.map((tid) => ({ tid }));
    }
  } catch {
    /* corrupt entry — fall through to a fresh tab */
  }
  const legacy = sessionStorage.getItem("conan.tid");
  const fresh = [{ tid: legacy ?? crypto.randomUUID() }];
  persistTerms(fresh); // persist immediately so a reload re-attaches to this pty
  return fresh;
}

function persistTerms(terms: TermTab[]): void {
  sessionStorage.setItem(TERMS_KEY, JSON.stringify(terms.map((t) => t.tid)));
}

/**
 * The right-hand dock: a draggable-width panel with a tabbed surface. It holds N
 * terminal tabs (US-026) plus a Tasks tab. Every terminal stays mounted at all
 * times (stacked, only the active one on top) so switching tabs never tears down
 * a pty and scrollback is preserved; the Tasks checklist overlays them. Each
 * terminal owns its own pty + WS keyed by a stable `tid`; closing a tab kills
 * that pty (and its terminal_session row) via an explicit close frame.
 */
export default function Dock({ token, theme, tasks }: DockProps) {
  const [terms, setTerms] = useState<TermTab[]>(loadTerms);
  const [active, setActive] = useState<Active>(() => ({
    kind: "term",
    tid: terms[0]!.tid, // loadTerms() always returns ≥1 tab
  }));
  const [width, setWidth] = useState<number>(
    () => Number(localStorage.getItem("conan-dock-w")) || 460,
  );
  const widthRef = useRef(width);
  // Per-tab "destroy on unmount" flags. Set just before removing a tab so the
  // Terminal's cleanup sends the backend close frame (US-026 criterion 3).
  const closeFlags = useRef(new Map<string, { current: boolean }>());
  const flagFor = (tid: string) => {
    let f = closeFlags.current.get(tid);
    if (!f) {
      f = { current: false };
      closeFlags.current.set(tid, f);
    }
    return f;
  };

  const isTermActive = active.kind === "term";

  const addTerm = useCallback(() => {
    const tid = crypto.randomUUID();
    setTerms((prev) => {
      const next = [...prev, { tid }];
      persistTerms(next);
      return next;
    });
    setActive({ kind: "term", tid });
  }, []);

  const closeTerm = useCallback(
    (tid: string) => {
      // Tell that Terminal's cleanup to kill the pty, then drop the tab.
      flagFor(tid).current = true;
      setTerms((prev) => {
        const next = prev.filter((t) => t.tid !== tid);
        // Never leave the dock with zero terminals — spawn a fresh one.
        const ensured = next.length ? next : [{ tid: crypto.randomUUID() }];
        persistTerms(ensured);
        // If the closed tab was active, fall back to the last remaining terminal.
        setActive((cur) =>
          cur.kind === "term" && cur.tid === tid
            ? { kind: "term", tid: ensured[ensured.length - 1]!.tid }
            : cur,
        );
        return ensured;
      });
    },
    [],
  );

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX));
      widthRef.current = w;
      setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      localStorage.setItem("conan-dock-w", String(widthRef.current));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
    >
      {/* drag handle on the left edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
      />

      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <TermDropdown
          terms={terms}
          active={active}
          onSelect={(tid) => setActive({ kind: "term", tid })}
          onClose={closeTerm}
          onNew={addTerm}
        />

        <div className="ml-auto">
          <TabButton
            active={active.kind === "tasks"}
            onClick={() => setActive({ kind: "tasks" })}
          >
            Tasks
            {tasks?.exists && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {tasks.done}/{tasks.total}
              </span>
            )}
          </TabButton>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* Every terminal stays mounted and sized (stacked, absolute inset-0) so
            switching tabs preserves scrollback and never tears down a pty. Only
            the active one sits on top + is interactive; the rest are hidden
            behind it. bg-term-bg + padding matches the terminal's own bg. */}
        {token ? (
          terms.map((t) => {
            const on = isTermActive && active.tid === t.tid;
            return (
              <div
                key={t.tid}
                className={
                  "absolute inset-0 bg-term-bg p-4 " +
                  (on ? "z-10" : "z-0 invisible")
                }
              >
                <Terminal
                  token={token}
                  theme={theme}
                  tid={t.tid}
                  closeOnUnmount={flagFor(t.tid)}
                />
              </div>
            );
          })
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-term-bg text-xs text-muted-foreground">
            connecting…
          </div>
        )}
        {active.kind === "tasks" && (
          <div className="absolute inset-0 z-20 bg-card">
            <TaskChecklist tasks={tasks} />
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * "Term ▾" dropdown (US-018): replaces the horizontal tab strip that overflowed
 * once several terminals were open. Lists Term 1..N (the active one marked),
 * each row carrying a close button that kills its pty, plus a "+ New terminal"
 * action. The terminals themselves stay mounted in the body below — this only
 * picks which one is on top, so scrollback is preserved.
 */
function TermDropdown({
  terms,
  active,
  onSelect,
  onClose,
  onNew,
}: {
  terms: TermTab[];
  active: Active;
  onSelect: (tid: string) => void;
  onClose: (tid: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeIdx =
    active.kind === "term"
      ? terms.findIndex((t) => t.tid === active.tid)
      : -1;
  const label = activeIdx >= 0 ? `Term ${activeIdx + 1}` : "Term";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Terminals"
        className={
          "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs " +
          (active.kind === "term"
            ? "bg-muted font-medium text-foreground"
            : "text-muted-foreground hover:bg-muted/60")
        }
      >
        {label}
        <span className="text-[10px] text-muted-foreground">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-44 rounded-md border border-border bg-card py-1 shadow-md">
          {terms.map((t, i) => {
            const on = active.kind === "term" && active.tid === t.tid;
            return (
              <div
                key={t.tid}
                className={
                  "group flex items-center text-xs " +
                  (on ? "bg-muted text-foreground" : "text-muted-foreground")
                }
              >
                <button
                  onClick={() => {
                    onSelect(t.tid);
                    setOpen(false);
                  }}
                  className="flex flex-1 items-center gap-2 py-1.5 pl-3 pr-1 text-left hover:text-foreground"
                >
                  <span
                    className={
                      "size-1.5 rounded-full " +
                      (on ? "bg-primary" : "bg-transparent")
                    }
                  />
                  Term {i + 1}
                </button>
                <button
                  onClick={() => onClose(t.tid)}
                  title="Close terminal"
                  className="mr-2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
          <div className="my-1 border-t border-border" />
          <button
            onClick={() => {
              onNew();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <span className="text-sm leading-none">+</span> New terminal
          </button>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center rounded-md px-2.5 py-1 text-xs " +
        (active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60")
      }
    >
      {children}
    </button>
  );
}

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
