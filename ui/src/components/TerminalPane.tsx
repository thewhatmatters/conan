import { useCallback, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import Terminal from "./Terminal.tsx";
import type { Theme } from "../hooks/useTheme.ts";
import { useTerminals, terminalLabel } from "../hooks/useTerminals.ts";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

// Tab-trigger styling tuned to match the flat header controls (no pill list,
// active = bg-muted) rather than shadcn's default card-with-shadow look.
const TAB_TRIGGER =
  "rounded-md px-2.5 py-1 text-xs font-normal text-muted-foreground transition-colors hover:bg-muted/60 data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

interface TerminalPaneProps {
  token: string | null;
  theme: Theme;
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
 * terminal filling the main area. Holds N terminal tabs behind a `Term ▾`
 * dropdown (US-026); every terminal stays mounted at all times (stacked, only
 * the active one on top) so switching tabs never tears down a pty and
 * scrollback is preserved (US-037: a tab switch is visual, never a kill). Each
 * terminal owns its own pty + WS keyed by a stable `tid`; closing a tab kills
 * that pty (and its terminal_session row) via an explicit close frame.
 */
export default function TerminalPane({ token, theme }: TerminalPaneProps) {
  const [terms, setTerms] = useState<TermTab[]>(loadTerms);
  const [activeTid, setActiveTid] = useState<string>(() => terms[0]!.tid);
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

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-card">
      <Tabs value="term">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-none bg-transparent p-0">
            <TermDropdown
              terms={terms}
              activeTid={activeTid}
              onSelect={setActiveTid}
              onClose={closeTerm}
              onNew={addTerm}
            />
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
    </section>
  );
}

/**
 * "Term ▾" dropdown (US-018): lists Term 1..N (the active one marked), each row
 * carrying a close button that kills its pty, plus a "+ New terminal" action.
 * The terminals themselves stay mounted in the body below — this only picks
 * which one is on top, so scrollback is preserved.
 */
function TermDropdown({
  terms,
  activeTid,
  onSelect,
  onClose,
  onNew,
}: {
  terms: TermTab[];
  activeTid: string;
  onSelect: (tid: string) => void;
  onClose: (tid: string) => void;
  onNew: () => void;
}) {
  // Per-tab Claude session info, polled so a mid-session /rename relabels live.
  const byTid = useTerminals();

  const labelIdx = terms.findIndex((t) => t.tid === activeTid);
  const label =
    labelIdx >= 0 ? terminalLabel(byTid.get(activeTid), labelIdx) : "Term";

  return (
    <DropdownMenu>
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
          const on = activeTid === t.tid;
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
