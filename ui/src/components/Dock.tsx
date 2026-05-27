import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import Terminal from "./Terminal.tsx";
import TaskChecklist from "./TaskChecklist.tsx";
import PulseChart from "./PulseChart.tsx";
import type { Theme } from "../hooks/useTheme.ts";
import type { TasksState } from "../hooks/useTasks.ts";
import type { PulseSeries } from "../hooks/usePulse.ts";
import { useTerminals, terminalLabel } from "../hooks/useTerminals.ts";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

// Tab-trigger styling tuned to match the dock's flat controls (no pill list,
// active = bg-muted) rather than shadcn's default card-with-shadow look.
const TAB_TRIGGER =
  "rounded-md px-2.5 py-1 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted/60 data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

interface DockProps {
  token: string | null;
  theme: Theme;
  tasks: TasksState | null;
  /**
   * Hide the dock without unmounting it (US-037). Toggling the terminal off
   * sets this true: the aside is display:none'd but every Terminal stays
   * mounted, so its pty + WS survive untouched and re-showing restores the
   * live session + scrollback. Only an explicit tab-close kills a pty.
   */
  hidden?: boolean;
  /**
   * US-004: the global Pulse time-series, pinned as a strip at the bottom of
   * the dock column. Stays global across all sessions (not scoped to the
   * active one). Omitted while still loading → the strip just shows empty.
   */
  pulse?: PulseSeries | null;
  pulseMinutes?: number;
  onPulseRange?: (minutes: number) => void;
}

const MIN_W = 320;
const MAX_W = 900;
const TERMS_KEY = "conan.terms"; // sessionStorage: ordered list of tab tids

/** A single terminal tab — its `tid` keys an independent pty on the backend. */
interface TermTab {
  tid: string;
}

/** The active dock surface: a specific terminal tab, or the Tasks tab. */
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
export default function Dock({
  token,
  theme,
  tasks,
  hidden,
  pulse,
  pulseMinutes = 60,
  onPulseRange,
}: DockProps) {
  const [terms, setTerms] = useState<TermTab[]>(loadTerms);
  const [active, setActive] = useState<Active>(() => ({
    kind: "term",
    tid: terms[0]!.tid, // loadTerms() always returns ≥1 tab
  }));
  // Remember the last terminal that was on top so switching back from Tasks via
  // the tab returns to it (rather than always snapping to the first terminal).
  const [lastTermTid, setLastTermTid] = useState<string>(terms[0]!.tid);
  useEffect(() => {
    if (active.kind === "term") setLastTermTid(active.tid);
  }, [active]);
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

  // US-039: the Tasks tab exists only when the active cwd has a task source
  // (prd.json, or progress.txt with content). The state is re-broadcast on every
  // cwd change (US-019), so this flips live as the toolbar picker switches
  // projects. When the source disappears while Tasks is the active surface, fall
  // back to the first terminal so the dock never strands on a vanished tab.
  const showTasks = Boolean(tasks?.hasSource);
  useEffect(() => {
    if (!showTasks && active.kind === "tasks") {
      setActive({ kind: "term", tid: terms[0]!.tid });
    }
  }, [showTasks, active, terms]);

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
      style={{ width, display: hidden ? "none" : undefined }}
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
    >
      {/* drag handle on the left edge */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
      />

      <Tabs
        value={active.kind}
        onValueChange={(v) =>
          setActive(
            v === "tasks"
              ? { kind: "tasks" }
              : { kind: "term", tid: lastTermTid },
          )
        }
      >
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0">
            <TermDropdown
              terms={terms}
              active={active}
              lastTermTid={lastTermTid}
              onSelect={(tid) => setActive({ kind: "term", tid })}
              onClose={closeTerm}
              onNew={addTerm}
            />

            {showTasks && (
              <TabsTrigger value="tasks" className={TAB_TRIGGER + " ml-auto"}>
                Tasks
                {tasks?.exists && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {tasks.done}/{tasks.total}
                  </span>
                )}
              </TabsTrigger>
            )}
          </TabsList>
        </div>
      </Tabs>

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

      {/* US-004: Pulse pinned to the bottom of the dock column — its own strip,
          not a third tab. Global across all sessions; shrink-0 so it coexists
          with the tabbed surface above and the drag-resize without breaking the
          layout. */}
      {onPulseRange && (
        <div className="shrink-0">
          <PulseChart
            series={pulse ?? null}
            minutes={pulseMinutes}
            onRange={onPulseRange}
            compact
          />
        </div>
      )}
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
  lastTermTid,
  onSelect,
  onClose,
  onNew,
}: {
  terms: TermTab[];
  active: Active;
  lastTermTid: string;
  onSelect: (tid: string) => void;
  onClose: (tid: string) => void;
  onNew: () => void;
}) {
  // Per-tab Claude session info, polled so a mid-session /rename relabels live.
  const byTid = useTerminals();

  // Trigger label tracks whichever terminal is (or was last) on top, so it stays
  // informative even while the Tasks surface is active.
  const labelTid = active.kind === "term" ? active.tid : lastTermTid;
  const labelIdx = terms.findIndex((t) => t.tid === labelTid);
  const label =
    labelIdx >= 0 ? terminalLabel(byTid.get(labelTid), labelIdx) : "Term";

  return (
    <DropdownMenu>
      {/* The dropdown's trigger doubles as the "term" tab: clicking it selects
          the terminal surface and opens the picker. */}
      <DropdownMenuTrigger asChild>
        <TabsTrigger
          value="term"
          title="Terminals"
          className={TAB_TRIGGER + " max-w-44 gap-1"}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </TabsTrigger>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-44">
        {terms.map((t, i) => {
          const on = active.kind === "term" && active.tid === t.tid;
          return (
            <DropdownMenuItem
              key={t.tid}
              onSelect={() => onSelect(t.tid)}
              className="group text-xs"
            >
              <span
                className={
                  "size-1.5 rounded-full " +
                  (on ? "bg-primary" : "bg-transparent")
                }
              />
              <span className="flex-1 truncate">
                {terminalLabel(byTid.get(t.tid), i)}
              </span>
              <button
                onClick={(e) => {
                  // Don't let the close button bubble into the item's select.
                  e.stopPropagation();
                  onClose(t.tid);
                }}
                title="Close terminal"
                className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
              >
                <CloseIcon />
              </button>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onNew}
          className="text-xs text-muted-foreground"
        >
          <span className="text-sm leading-none">+</span> New terminal
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
