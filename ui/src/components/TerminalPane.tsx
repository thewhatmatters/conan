import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClockFading, Folder, PanelRight, Plus } from "lucide-react";
import Terminal from "./Terminal.tsx";
import StatusBar from "./StatusBar.tsx";
import FileExplorer from "./FileExplorer.tsx";
import type { Theme } from "../hooks/useTheme.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import {
  useTerminals,
  terminalLabel,
  terminalLabels,
} from "../hooks/useTerminals.ts";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import Timeline from "./Timeline.tsx";
import ContextHeader from "./ContextHeader.tsx";
import HudTabHeader from "./shared/HudTabHeader.tsx";
import type { Session } from "../hooks/useSessions.ts";
import type {
  GatewayEvent,
  PlanEvent,
  SkillConsideredEvent,
  SkillFiredEvent,
  TasksState,
} from "../hooks/useTasks.ts";

// PROTOTYPE: minimum + default width for the per-tab Timeline split (px).
const TIMELINE_MIN_W = 320;
const TIMELINE_DEFAULT_W = 480;

// VS Code–style tabs: flat (no pill/filled background); the active tab is marked
// by a subtle top accent border + bolder foreground text instead of a bg fill.
// border-t-2 border-transparent reserves the space on every tab so the accent
// doesn't shift layout when it appears.
const TAB_TRIGGER =
  "group shrink-0 max-w-44 rounded-none border-t border-transparent py-1.5 pl-3 pr-2 text-xs font-normal text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-muted data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

interface TerminalPaneProps {
  token: string | null;
  theme: Theme;
  /** App-wide active cwd for the bottom status bar (US-004). */
  cwd?: string | null;
  /** Active session's git branch/dirty for the status bar (US-004). */
  git?: WidgetData["git"] | null;
  /** US-003: report the active terminal tab's tid upward (mount, switch, new,
   *  close) so the HUD can bind its session-scoped widgets to the visible tab. */
  onActiveTidChange?: (tid: string) => void;
  /** Build-loop progress.txt activity (US-004 v4.5): forwarded to the
   *  per-tab Timeline split so it can append loop rows live. */
  tasks?: TasksState | null;
  /** Shared app-WS signals (US-004 v4.5) forwarded to the Timeline split.
   *  The Timeline filters them by its bound session id. */
  lastEvent?: (GatewayEvent & { seq: number; replay?: boolean }) | null;
  lastSkillFired?: SkillFiredEvent | null;
  lastSkillConsidered?: SkillConsideredEvent | null;
  /** Live TodoWrite / ExitPlanMode broadcast (US-007 v4.5) — fed to PLAN rows. */
  lastPlan?: PlanEvent | null;
  /** Live per-tab cwd broadcast — patched into useTerminals so each tab's
   *  File Explorer view re-lists as you `cd` inside that tab. */
  lastTerminalCwd?: { tid: string; cwd: string; seq: number } | null;
  // — context-header bindings (dropped-Context-tab refactor) —
  /** Active session — drives the per-terminal ContextHeader's data + actions. */
  activeSession?: Session | null;
  /** All known sessions — lets the estimate fallback infer a 1M window. */
  sessions?: Session[];
  /** Widgets payload (liveContext + estimate fallback) for ContextHeader. */
  widgetData?: WidgetData | null;
  /** Re-pull widgets after a /context capture lands. */
  onRefetchWidgets?: () => void;
  /** Live window width (px) for responsive Timeline layout — at narrow
   *  widths the Timeline split overlays the terminal instead of side-by-side. */
  windowWidth?: number;
  /** Claude Code install detection — drives the "Install Claude Code" banner
   *  pinned above the terminal when missing. Null while loading (banner hidden). */
  doctor?: { installed: boolean | null };
}

/** Window width at which the per-tab Timeline split overlays the terminal
 *  column at full width instead of taking a side-by-side slice. Below this
 *  there isn't enough horizontal room for both surfaces to be usable. The
 *  terminal stays mounted underneath (just visually hidden) so the pty
 *  keeps running and switching back is instant. */
const TIMELINE_OVERLAY_BREAKPOINT = 720;

const TERMS_KEY = "conan.terms"; // sessionStorage: ordered list of tab tids
// US-005: per-tab Timeline split persistence — independent keys, so existing
// terminal-restore code (TERMS_KEY) keeps working unchanged.
const TIMELINE_OPEN_KEY = "conan.terms.timeline"; // JSON string[] of open tids
const TIMELINE_WIDTH_KEY = "conan.terms.timeline.w"; // JSON Record<tid, number>
// The right panel now hosts BOTH the Files explorer and the Timeline; this
// records which view each tab last had selected. (TIMELINE_OPEN/WIDTH above are
// now really the shared panel's open-set + width — names kept for storage compat.)
const RIGHTPANEL_TAB_KEY = "conan.terms.rightpanel.tab"; // JSON Record<tid,'files'|'timeline'>

/** Which view the per-tab right panel is showing. */
type PanelTab = "files" | "timeline";

/** A single terminal tab — its `tid` keys an independent pty on the backend. */
interface TermTab {
  tid: string;
}

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

/** US-005: restore the per-tab Timeline-open set from sessionStorage. */
function loadTimelineOpen(): Set<string> {
  try {
    const raw = sessionStorage.getItem(TIMELINE_OPEN_KEY);
    if (raw) {
      const ids = JSON.parse(raw) as unknown;
      if (Array.isArray(ids)) {
        return new Set(ids.filter((x): x is string => typeof x === "string"));
      }
    }
  } catch {
    /* corrupt entry — fall through to an empty set */
  }
  return new Set();
}

/** US-005: restore the per-tab Timeline width map from sessionStorage. */
function loadTimelineWidth(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(TIMELINE_WIDTH_KEY);
    if (raw) {
      const m = JSON.parse(raw) as unknown;
      if (m && typeof m === "object" && !Array.isArray(m)) {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        }
        return out;
      }
    }
  } catch {
    /* corrupt entry — fall through to an empty map */
  }
  return {};
}

/** Restore the per-tab right-panel view (Files vs Timeline) from sessionStorage. */
function loadRightPanelTab(): Record<string, PanelTab> {
  try {
    const raw = sessionStorage.getItem(RIGHTPANEL_TAB_KEY);
    if (raw) {
      const m = JSON.parse(raw) as unknown;
      if (m && typeof m === "object" && !Array.isArray(m)) {
        const out: Record<string, PanelTab> = {};
        for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
          if (v === "files" || v === "timeline") out[k] = v;
        }
        return out;
      }
    }
  } catch {
    /* corrupt entry — fall through to an empty map */
  }
  return {};
}

/** Skip the global ⌘\ shortcut when typing into a real text input (forms,
 *  dialogs); xterm's helper textarea is the terminal, not a text input, so we
 *  intentionally let the shortcut through there too. */
function isUserTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    if (target.closest(".xterm")) return false;
    return true;
  }
  if (target.isContentEditable) return true;
  return false;
}

/**
 * The primary surface (US-003 terminal-wrapper reshape): the Claude Code
 * terminal filling the main area. Holds N terminal tabs in a real tab strip
 * (US-009, replacing the old `Term ▾` dropdown); every terminal stays mounted
 * at all times (stacked, only
 * the active one on top) so switching tabs never tears down a pty and
 * scrollback is preserved (US-037: a tab switch is visual, never a kill). Each
 * terminal owns its own pty + WS keyed by a stable `tid`; closing a tab kills
 * that pty (and its terminal_session row) via an explicit close frame.
 */
export default function TerminalPane({
  token,
  theme,
  cwd,
  git,
  onActiveTidChange,
  tasks,
  lastEvent,
  lastSkillFired,
  lastSkillConsidered,
  lastPlan,
  lastTerminalCwd,
  activeSession,
  sessions,
  widgetData,
  onRefetchWidgets,
  windowWidth,
  doctor,
}: TerminalPaneProps) {
  // Below this width the Timeline overlays the terminal at full width; above
  // it the historical side-by-side split + draggable divider stay in play.
  const timelineOverlay =
    typeof windowWidth === "number" && windowWidth < TIMELINE_OVERLAY_BREAKPOINT;
  const [terms, setTerms] = useState<TermTab[]>(loadTerms);
  const [activeTid, setActiveTid] = useState<string>(() => terms[0]!.tid);
  // PROTOTYPE: per-tab Timeline split state — which tabs have the right-hand
  // Timeline panel open, and its current pixel width per tab. Keyed by tid so
  // the split is *tethered* to a specific terminal (its session). Closes
  // automatically when the tab closes (via closeTerm cleanup below). US-005:
  // restored from sessionStorage so a reload preserves what the user had open.
  const [timelineOpen, setTimelineOpen] = useState<Set<string>>(loadTimelineOpen);
  const [timelineWidth, setTimelineWidth] = useState<Record<string, number>>(
    loadTimelineWidth,
  );
  // Which view (Files vs Timeline) each tab's right panel is showing. Defaults
  // to "timeline" for tabs with no stored choice, preserving prior behavior.
  const [rightPanelTab, setRightPanelTab] = useState<Record<string, PanelTab>>(
    loadRightPanelTab,
  );
  const panelTabFor = (tid: string): PanelTab => rightPanelTab[tid] ?? "timeline";
  const setPanelTab = (tid: string, tab: PanelTab) =>
    setRightPanelTab((prev) => (prev[tid] === tab ? prev : { ...prev, [tid]: tab }));

  // US-005: persist the open-set on every toggle/close (rare changes, no debounce).
  useEffect(() => {
    try {
      sessionStorage.setItem(
        TIMELINE_OPEN_KEY,
        JSON.stringify(Array.from(timelineOpen)),
      );
    } catch {
      /* sessionStorage may be unavailable (private mode); ignore */
    }
  }, [timelineOpen]);

  // US-005: persist widths debounced — drag-resize updates state on every
  // mousemove, so a 150ms trailing-edge write absorbs the entire drag.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sessionStorage.setItem(
          TIMELINE_WIDTH_KEY,
          JSON.stringify(timelineWidth),
        );
      } catch {
        /* sessionStorage may be unavailable; ignore */
      }
    }, 150);
    return () => clearTimeout(t);
  }, [timelineWidth]);

  // Persist the per-tab right-panel view (Files vs Timeline) on change — rare,
  // so no debounce needed.
  useEffect(() => {
    try {
      sessionStorage.setItem(RIGHTPANEL_TAB_KEY, JSON.stringify(rightPanelTab));
    } catch {
      /* sessionStorage may be unavailable; ignore */
    }
  }, [rightPanelTab]);
  // US-003: surface the active tab's tid upward on every change (initial mount,
  // tab switch, new, close) so App can repoint the session-scoped HUD widgets.
  useEffect(() => {
    onActiveTidChange?.(activeTid);
  }, [activeTid, onActiveTidChange]);
  // Per-tab Claude session info, so a notification click can jump to the tab
  // whose pty runs the prompting session (US-011). Kept in a ref so the
  // `conan:focus-session` listener reads the live map without rebinding.
  const byTid = useTerminals(lastTerminalCwd ?? null);
  const byTidRef = useRef(byTid);
  byTidRef.current = byTid;
  // Tab-strip labels (1.0.1 US-003): cwd folder basenames with duplicate
  // disambiguation, computed once per render for the whole strip.
  const tabLabels = useMemo(
    () => terminalLabels(terms, byTid),
    [terms, byTid],
  );
  const labelFor = (tid: string, i: number) =>
    tabLabels.get(tid) ?? terminalLabel(byTid.get(tid), i);
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

  const addTerm = useCallback(() => {
    const tid = crypto.randomUUID();
    setTerms((prev) => {
      const next = [...prev, { tid }];
      persistTerms(next);
      return next;
    });
    setActiveTid(tid);
  }, []);

  const closeTerm = useCallback((tid: string) => {
    // Tell that Terminal's cleanup to kill the pty, then drop the tab.
    flagFor(tid).current = true;
    setTerms((prev) => {
      const next = prev.filter((t) => t.tid !== tid);
      // Never leave the pane with zero terminals — spawn a fresh one.
      const ensured = next.length ? next : [{ tid: crypto.randomUUID() }];
      persistTerms(ensured);
      // If the closed tab was active, fall back to the last remaining terminal.
      setActiveTid((cur) =>
        cur === tid ? ensured[ensured.length - 1]!.tid : cur,
      );
      return ensured;
    });
    // PROTOTYPE: drop the Timeline split state for the closed tab too.
    setTimelineOpen((prev) => {
      if (!prev.has(tid)) return prev;
      const next = new Set(prev);
      next.delete(tid);
      return next;
    });
    setTimelineWidth((prev) => {
      if (!(tid in prev)) return prev;
      const { [tid]: _, ...rest } = prev;
      return rest;
    });
    setRightPanelTab((prev) => {
      if (!(tid in prev)) return prev;
      const { [tid]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  // PROTOTYPE: toggle the right-hand Timeline split for the active tab.
  const toggleTimelineForActive = useCallback(() => {
    setTimelineOpen((prev) => {
      const next = new Set(prev);
      const tid = activeTidRef.current;
      if (next.has(tid)) next.delete(tid);
      else next.add(tid);
      return next;
    });
  }, []);

  // PROTOTYPE: drag-resize the Timeline split for a specific tab. Tracks the
  // active mouse delta against the start width so the split feels smooth and
  // never crosses TIMELINE_MIN_W on the left.
  const startResizeTimeline = useCallback(
    (tid: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = timelineWidth[tid] ?? TIMELINE_DEFAULT_W;
      const onMove = (ev: MouseEvent) => {
        const w = Math.max(TIMELINE_MIN_W, startW + (startX - ev.clientX));
        setTimelineWidth((prev) => ({ ...prev, [tid]: w }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [timelineWidth],
  );

  // Bridge the native menu's File ▸ New/Close Terminal (App dispatches these
  // window events) to the local tab state. Close acts on the active terminal.
  // A ref keeps the listener bound to the live active tid without rebinding.
  const activeTidRef = useRef(activeTid);
  activeTidRef.current = activeTid;
  useEffect(() => {
    const onNew = () => addTerm();
    const onClose = () => closeTerm(activeTidRef.current);
    window.addEventListener("conan:new-terminal", onNew);
    window.addEventListener("conan:close-terminal", onClose);
    return () => {
      window.removeEventListener("conan:new-terminal", onNew);
      window.removeEventListener("conan:close-terminal", onClose);
    };
  }, [addTerm, closeTerm]);

  // US-005: ⌘\ (CmdOrCtrl+Backslash) toggles the Timeline split for the active
  // tab — works whether focus is on the terminal or the HUD because the
  // listener is at window level in the capture phase (fires before xterm.js
  // claims the keystroke). Skip when typing into a real text input (Settings,
  // forms). The native menu bridge `conan:toggle-timeline` (dispatched by the
  // View ▸ Split Timeline menu item) lands here too so both paths converge.
  useEffect(() => {
    const onToggle = () => toggleTimelineForActive();
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "\\" && e.code !== "Backslash") return;
      if (isUserTextInput(e.target)) return;
      e.preventDefault();
      toggleTimelineForActive();
    };
    window.addEventListener("conan:toggle-timeline", onToggle);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("conan:toggle-timeline", onToggle);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [toggleTimelineForActive]);

  // US-011: a clicked native notification dispatches `conan:focus-session` with
  // the prompting session id; select the terminal tab whose pty runs it so the
  // user lands on the prompt to answer it.
  useEffect(() => {
    const onFocusSession = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sid) return;
      for (const [tid, info] of byTidRef.current) {
        if (info.sessionId === sid) {
          setActiveTid(tid);
          break;
        }
      }
    };
    window.addEventListener("conan:focus-session", onFocusSession);
    return () =>
      window.removeEventListener("conan:focus-session", onFocusSession);
  }, []);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <InstallBanner doctor={doctor} />
      <div className="flex items-center border-b border-border">
        <Tabs
          value={activeTid}
          onValueChange={setActiveTid}
          className="min-w-0 flex-1"
        >
          {/* A real tab strip (US-009): one trigger per terminal, scrolling
              horizontally when many are open (no wrap). Flush, contiguous tabs
              (no gap/padding) so the active fill + 1px top accent read as a tab. */}
          <TabsList className="flex h-auto w-full justify-start overflow-x-auto rounded-none bg-transparent p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {terms.map((t, i) => (
              <TabsTrigger
                key={t.tid}
                value={t.tid}
                title={labelFor(t.tid, i)}
                className={TAB_TRIGGER}
              >
                <span className="truncate">{labelFor(t.tid, i)}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Close terminal"
                  title="Close terminal"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    // Don't let the close click bubble into the tab's select.
                    e.stopPropagation();
                    closeTerm(t.tid);
                  }}
                  className="ml-1 inline-flex rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 group-data-[state=active]:opacity-100"
                >
                  <CloseIcon />
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <button
          onClick={addTerm}
          title="New terminal"
          aria-label="New terminal"
          className="mx-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
        {/* PROTOTYPE: per-tab Timeline split toggle — tethered to the active tab.
            US-003: reads as a real toggle — when the split is open it gets a
            filled (bg-primary/10) pressed state + primary accent so it's clear
            the same button also closes it. Semantic tokens only. */}
        <button
          onClick={toggleTimelineForActive}
          title="Toggle panel (⌘\)"
          aria-label="Toggle panel (⌘\)"
          aria-pressed={timelineOpen.has(activeTid)}
          className={
            "mr-1 shrink-0 rounded-md p-1 transition-colors " +
            (timelineOpen.has(activeTid)
              ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground")
          }
        >
          <PanelRight className="size-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* Every terminal stays mounted and sized (stacked, absolute inset-0) so
            switching tabs preserves scrollback and never tears down a pty. Only
            the active one sits on top + is interactive; the rest are hidden
            behind it. Each container is itself a horizontal flex: terminal on
            the left + an optional Timeline split on the right (PROTOTYPE) —
            tethered to THIS tab's session, with a draggable col-resize divider. */}
        {token ? (
          terms.map((t, i) => {
            const on = activeTid === t.tid;
            const tlOn = timelineOpen.has(t.tid);
            const tlW = timelineWidth[t.tid] ?? TIMELINE_DEFAULT_W;
            const info = byTid.get(t.tid);
            const panelTab = panelTabFor(t.tid);
            // The shared right-panel body: a Files | Timeline switch above the
            // selected view. Built once and slotted into whichever aside layout
            // (overlay vs side-by-side) applies, so the two stay in lockstep.
            const panel = (
              <div className="flex h-full min-h-0 flex-col bg-card">
                {/* Files | Timeline switch — rides the shared <HudTabHeader> so
                    this secondary toolbar is the exact same chrome + height
                    (h-9) as the HUD's Usage/Skills/MCP secondary toolbars. */}
                <HudTabHeader
                  name={
                    <>
                      <PanelTabBtn
                        active={panelTab === "files"}
                        onClick={() => setPanelTab(t.tid, "files")}
                        icon={<Folder className="size-3.5" />}
                        label="Files"
                      />
                      <PanelTabBtn
                        active={panelTab === "timeline"}
                        onClick={() => setPanelTab(t.tid, "timeline")}
                        icon={<ClockFading className="size-3.5" />}
                        label="Timeline"
                      />
                    </>
                  }
                />
                <div className="min-h-0 flex-1">
                  {panelTab === "files" ? (
                    <FileExplorer
                      token={token}
                      sessionId={info?.sessionId ?? null}
                      cwd={info?.cwd ?? cwd ?? null}
                      lastEvent={lastEvent ?? null}
                    />
                  ) : (
                    <Timeline
                      token={token}
                      sessionId={info?.sessionId ?? null}
                      terminalLabel={labelFor(t.tid, i)}
                      lastEvent={lastEvent ?? null}
                      lastSkillFired={lastSkillFired ?? null}
                      lastSkillConsidered={lastSkillConsidered ?? null}
                      lastPlan={lastPlan ?? null}
                      tasks={tasks ?? null}
                    />
                  )}
                </div>
              </div>
            );
            return (
              <div
                key={t.tid}
                className={
                  "absolute inset-0 flex " + (on ? "z-10" : "z-0 invisible")
                }
              >
                {/* Terminal column — flex-col so the ContextHeader sits above
                    the terminal but stays constrained to THIS column's width
                    (not the timeline split's). The banner replaces the HUD's
                    Context tab; it binds to the app-wide active session so the
                    visible column always shows the right data. */}
                <div className="flex min-w-0 flex-1 flex-col">
                  <ContextHeader
                    activeSession={activeSession ?? null}
                    sessions={sessions}
                    data={widgetData ?? null}
                    token={token}
                    onRefetch={onRefetchWidgets}
                  />
                  <div className="min-h-0 flex-1 bg-term-bg p-4">
                    <Terminal
                      token={token}
                      theme={theme}
                      tid={t.tid}
                      closeOnUnmount={flagFor(t.tid)}
                      active={on}
                    />
                  </div>
                </div>
                {tlOn &&
                  (timelineOverlay ? (
                    /* Narrow window: the panel overlays the terminal column at
                       full width. Terminal stays mounted underneath (z-0) so
                       its pty keeps running; closing the panel reveals it again
                       instantly with all scrollback intact. No drag divider —
                       there's nothing to size against. */
                    <aside className="absolute inset-0 z-20 bg-card">{panel}</aside>
                  ) : (
                    /* Wide window: classic side-by-side split with a draggable
                       divider. The terminal column keeps its remaining slice. */
                    <>
                      <div
                        onMouseDown={startResizeTimeline(t.tid)}
                        title="Drag to resize"
                        className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-primary/40"
                      />
                      <aside style={{ width: tlW }} className="shrink-0 bg-card">
                        {panel}
                      </aside>
                    </>
                  ))}
              </div>
            );
          })
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-term-bg text-xs text-muted-foreground">
            connecting…
          </div>
        )}
      </div>

      <StatusBar cwd={cwd} git={git} />
    </section>
  );
}

/** A compact segmented-control button for the right panel's Files | Timeline
 *  switch. Active = filled muted bg + bold foreground (VS Code tab feel). */
function PanelTabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-normal transition-colors " +
        (active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60")
      }
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * One-line banner pinned above the terminal tab strip when the gateway's
 * doctor probe reports `claude` is not installed. Dismissible per-session
 * (sessionStorage), so a fresh launch reminds the user but a casual reload
 * doesn't nag. Hidden during the initial probe (`installed: null`) to avoid
 * a flash; hidden permanently once the user dismisses or installs Claude.
 *
 * Why this lives here vs an empty-state inside the terminal: a fresh user
 * with no Claude installed still gets a working shell in the pty (the
 * `${CLAUDE_BIN}; exec $SHELL -i -l` fallback in resolveCommand). The shell
 * is useful for installing Claude, so we keep it visible — the banner just
 * explains what's missing and how to fix it.
 */
function InstallBanner({
  doctor,
}: {
  doctor?: { installed: boolean | null };
}) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(BANNER_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (!doctor || doctor.installed !== false || dismissed) return null;
  const dismiss = () => {
    try {
      sessionStorage.setItem(BANNER_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
      <span className="min-w-0">
        <span className="font-medium">Claude Code isn't installed.</span>{" "}
        Conan watches it but can't run it for you. Install:{" "}
        <code className="rounded bg-amber-500/15 px-1 py-px font-mono text-[10px]">
          npm install -g @anthropic-ai/claude-code
        </code>{" "}
        or see{" "}
        <a
          href="https://claude.com/claude-code"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
        >
          docs
        </a>
        .
      </span>
      <button
        type="button"
        onClick={dismiss}
        title="Dismiss for this session"
        className="shrink-0 rounded p-0.5 text-amber-700/70 transition-colors hover:bg-amber-500/15 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-100"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

const BANNER_DISMISS_KEY = "conan.doctor.banner.dismissed";

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
