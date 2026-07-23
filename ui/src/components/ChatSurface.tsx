import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import ChatPane, { type ThreadUiState } from "./ChatPane.tsx";
import StatusBar from "./StatusBar.tsx";
import { useDirGit } from "../hooks/useDirGit.ts";
import { cn } from "../lib/utils.ts";

/**
 * Multi-thread chat surface (US-006): a collapsible left sidebar of chat
 * threads grouped by project, beside the active thread's ChatPane.
 *
 * Each thread owns its own ChatPane — and therefore its own useAgentChat WS +
 * headless `claude` process. Threads stay MOUNTED when inactive (hidden via
 * visibility/z-index, the same pattern App.tsx uses for the Terminal|Chat
 * surfaces and TerminalPane uses for tabs) so switching never tears down a
 * running turn. Closing a thread unmounts its pane, which closes the WS and
 * ends the gateway session.
 *
 * Ephemeral by design for this story: threads live in memory only, a reload
 * starts empty (persistence lands in US-013..015).
 */

interface Thread {
  id: string;
  /** Working directory chosen at creation (US-011 adds a picker); null falls
   *  back to the app's active cwd at render time. */
  cwd: string | null;
}

/** Sidebar status pill, derived from the thread's reported state. */
type Pill = "working" | "awaiting" | "ready" | "idle";

function pillOf(s: ThreadUiState | undefined): Pill {
  if (!s) return "idle";
  if (s.awaitingApproval) return "awaiting";
  if (s.busy) return "working";
  if (s.status === "open") return "ready";
  return "idle";
}

const PILL: Record<Pill, { label: string; cls: string; dot: string }> = {
  working: {
    label: "Working",
    cls: "bg-primary/10 text-primary",
    dot: "bg-primary animate-pulse",
  },
  awaiting: {
    label: "Awaiting approval",
    cls: "bg-destructive/10 text-destructive",
    dot: "bg-destructive animate-pulse",
  },
  ready: { label: "Ready", cls: "bg-muted text-muted-foreground", dot: "bg-chart-2" },
  idle: { label: "Idle", cls: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50" },
};

/** Project label for grouping: the cwd's basename. */
function projectOf(cwd: string | null): string {
  if (!cwd) return "workspace";
  const base = cwd.replace(/\/+$/, "").split("/").pop();
  return base || cwd;
}

export default function ChatSurface({
  token,
  defaultCwd,
  onActiveSessionChange,
}: {
  token: string | null;
  /** The app's active cwd (from /api/config) — the default project for new
   *  threads until the US-011 picker lands. */
  defaultCwd: string | null;
  /** Reports the ACTIVE thread's Claude session id up to the shell (US-012)
   *  so session-scoped concerns (native notifications) follow the thread the
   *  user is looking at — the chat-era replacement for pty correlation. */
  onActiveSessionChange?: (sessionId: string | null) => void;
}) {
  const seq = useRef(0);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ThreadUiState>>({});
  const [collapsed, setCollapsed] = useState(false);

  const newThread = useCallback(() => {
    const id = `t${++seq.current}`;
    setThreads((prev) => [...prev, { id, cwd: null }]);
    setActiveId(id);
  }, []);

  // US-011: the composer's cwd chip reports a picked directory up so the
  // sidebar's project grouping + the StatusBar follow the choice.
  const setThreadCwd = useCallback((id: string, cwd: string) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, cwd } : t)));
  }, []);

  // One draft thread on first render so the surface is immediately usable.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    newThread();
  }, [newThread]);

  // Per-thread state reports from hidden panes drive the pills. Bail when
  // nothing changed so re-reports from parent re-renders can't loop.
  const reportState = useCallback((id: string, s: ThreadUiState) => {
    setStates((prev) => {
      const cur = prev[id];
      if (
        cur &&
        cur.status === s.status &&
        cur.busy === s.busy &&
        cur.awaitingApproval === s.awaitingApproval &&
        cur.title === s.title &&
        cur.sessionId === s.sessionId
      ) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  const closeThread = (id: string) => {
    const idx = threads.findIndex((t) => t.id === id);
    const next = threads.filter((t) => t.id !== id);
    setThreads(next);
    if (activeId === id) {
      setActiveId(next[Math.min(idx, next.length - 1)]?.id ?? null);
    }
    setStates((prev) => {
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
  };

  // US-012: File ▸ New Chat / Close Chat menu items dispatch window events —
  // the same decoupled bridge the File menu used for terminals. No dep array:
  // closeThread closes over threads/activeId, so re-subscribing per render
  // keeps the handlers current.
  useEffect(() => {
    const onNew = () => newThread();
    const onClose = () => {
      if (activeId) closeThread(activeId);
    };
    window.addEventListener("conan:new-chat", onNew);
    window.addEventListener("conan:close-chat", onClose);
    return () => {
      window.removeEventListener("conan:new-chat", onNew);
      window.removeEventListener("conan:close-chat", onClose);
    };
  });

  // US-012: surface the active thread's Claude session id to the shell.
  const activeSessionId = activeId ? states[activeId]?.sessionId ?? null : null;
  useEffect(() => {
    onActiveSessionChange?.(activeSessionId);
  }, [activeSessionId, onActiveSessionChange]);

  // Group threads by project (cwd basename), preserving creation order.
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const name = projectOf(t.cwd ?? defaultCwd);
    const list = groups.get(name);
    if (list) list.push(t);
    else groups.set(name, [t]);
  }

  // US-011: the StatusBar follows the ACTIVE thread's effective cwd, with the
  // git branch polled for that directory (chat threads have no correlated
  // session to derive git from).
  const activeThread = threads.find((t) => t.id === activeId) ?? null;
  const activeCwd = activeThread ? activeThread.cwd ?? defaultCwd : defaultCwd;
  const activeGit = useDirGit(token, activeCwd);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
      {collapsed ? (
        <div className="flex w-9 shrink-0 flex-col items-center border-r border-border bg-card">
          <div className="flex h-9 shrink-0 items-center">
            <IconButton title="Expand sidebar" onClick={() => setCollapsed(false)}>
              <PanelLeftOpen className="size-4" />
            </IconButton>
          </div>
          <IconButton title="New chat" onClick={newThread}>
            <MessageSquarePlus className="size-4" />
          </IconButton>
        </div>
      ) : (
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
            <span className="flex-1 text-[11px] font-medium text-muted-foreground">
              Chats
            </span>
            <IconButton title="New chat" onClick={newThread}>
              <MessageSquarePlus className="size-4" />
            </IconButton>
            <IconButton title="Collapse sidebar" onClick={() => setCollapsed(true)}>
              <PanelLeftClose className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {threads.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground">
                No chats yet.
              </p>
            ) : (
              [...groups.entries()].map(([project, list]) => (
                <div key={project} className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {project}
                  </div>
                  {list.map((t) => (
                    <ThreadRow
                      key={t.id}
                      title={states[t.id]?.title ?? null}
                      pill={pillOf(states[t.id])}
                      active={t.id === activeId}
                      onSelect={() => setActiveId(t.id)}
                      onClose={() => closeThread(t.id)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      {/* Thread panes — all mounted, only the active one visible/interactive. */}
      <div className="relative min-h-0 min-w-0 flex-1">
        {threads.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <p className="text-sm">No open chats.</p>
            <button
              onClick={newThread}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              New chat
            </button>
          </div>
        )}
        {threads.map((t) => (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0 flex",
              t.id === activeId ? "z-10" : "invisible z-0",
            )}
          >
            <ChatPane
              token={token}
              cwd={t.cwd}
              defaultCwd={defaultCwd}
              onCwdChange={(c) => setThreadCwd(t.id, c)}
              onState={(s) => reportState(t.id, s)}
            />
          </div>
        ))}
        </div>
      </div>
      <StatusBar cwd={activeCwd} git={activeGit} />
    </section>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function ThreadRow({
  title,
  pill,
  active,
  onSelect,
  onClose,
}: {
  title: string | null;
  pill: Pill;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const p = PILL[pill];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-xs" title={title ?? "New chat"}>
        {title ?? "New chat"}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium",
          p.cls,
        )}
      >
        <span className={cn("size-1.5 rounded-full", p.dot)} />
        {p.label}
      </span>
      <button
        type="button"
        title="Close chat"
        aria-label="Close chat"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "shrink-0 rounded p-0.5 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100",
          active ? "opacity-60" : "opacity-0",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
