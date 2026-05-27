import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import Terminal from "./Terminal.tsx";
import StatusBar from "./StatusBar.tsx";
import type { Theme } from "../hooks/useTheme.ts";
import type { ConnStatus } from "../hooks/useTasks.ts";
import type { WidgetData } from "../hooks/useWidgets.ts";
import { useTerminals, terminalLabel } from "../hooks/useTerminals.ts";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";

// VS Code–style tabs: flat (no pill/filled background); the active tab is marked
// by a subtle top accent border + bolder foreground text instead of a bg fill.
// border-t-2 border-transparent reserves the space on every tab so the accent
// doesn't shift layout when it appears.
const TAB_TRIGGER =
  "group shrink-0 max-w-44 rounded-none border-t border-transparent py-1.5 pl-3 pr-2 text-xs font-normal text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-muted data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

interface TerminalPaneProps {
  token: string | null;
  theme: Theme;
  /** App-wide active cwd for the bottom status bar (US-010). */
  cwd?: string | null;
  /** Active session's git branch/dirty for the status bar (US-010). */
  git?: WidgetData["git"] | null;
  /** Gateway WS status for the status bar — moved out of the HUD (US-010). */
  status: ConnStatus;
  /** Gateway port, shown when connected. */
  port?: number;
}

const TERMS_KEY = "conan.terms"; // sessionStorage: ordered list of tab tids

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
  status,
  port,
}: TerminalPaneProps) {
  const [terms, setTerms] = useState<TermTab[]>(loadTerms);
  const [activeTid, setActiveTid] = useState<string>(() => terms[0]!.tid);
  // Per-tab Claude session info, so a notification click can jump to the tab
  // whose pty runs the prompting session (US-011). Kept in a ref so the
  // `conan:focus-session` listener reads the live map without rebinding.
  const byTid = useTerminals();
  const byTidRef = useRef(byTid);
  byTidRef.current = byTid;
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
  }, []);

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
    <section className="relative flex min-w-0 flex-1 flex-col bg-card">
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
                title={terminalLabel(byTid.get(t.tid), i)}
                className={TAB_TRIGGER}
              >
                <span className="truncate">
                  {terminalLabel(byTid.get(t.tid), i)}
                </span>
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
      </div>

      <div className="relative min-h-0 flex-1">
        {/* Every terminal stays mounted and sized (stacked, absolute inset-0) so
            switching tabs preserves scrollback and never tears down a pty. Only
            the active one sits on top + is interactive; the rest are hidden
            behind it. bg-term-bg + padding matches the terminal's own bg. */}
        {token ? (
          terms.map((t) => {
            const on = activeTid === t.tid;
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
      </div>

      <StatusBar cwd={cwd} git={git} status={status} port={port} />
    </section>
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
