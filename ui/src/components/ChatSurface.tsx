import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import ChatPane, { type ThreadUiState } from "./ChatPane.tsx";
import DirBrowser, { basename } from "./DirBrowser.tsx";
import { isTauri } from "../lib/gateway.ts";
import { cn } from "../lib/utils.ts";

/**
 * Project-organized chat surface (US-006 sidebar shell, US-025 projects): a
 * collapsible left sidebar of Projects — each a first-class {id, path, name}
 * created from a folder picker — with their chat threads nested beneath,
 * beside the active thread's ChatPane.
 *
 * A Thread BELONGS to a project and inherits the project's path as its cwd;
 * there is no per-thread directory divergence (that would make the grouping
 * lie). Each thread owns its own ChatPane — and therefore its own useAgentChat
 * WS + headless `claude` process. Threads stay MOUNTED when inactive (hidden
 * via visibility/z-index, the same pattern App.tsx used for the terminal-era
 * surfaces) so switching never tears down a running turn. Closing a thread
 * unmounts its pane, which closes the WS and ends the gateway session.
 *
 * Ephemeral by design for this story: projects + threads live in memory only,
 * a reload starts empty (persistence lands in US-013/US-014).
 */

/** First-class project: a chosen folder that chats live inside (US-025). */
interface Project {
  id: string;
  /** Absolute path of the project folder — every thread's cwd. */
  path: string;
  /** Display name: the folder basename. */
  name: string;
}

interface Thread {
  id: string;
  projectId: string;
  /** Creation time, for the sidebar's relative timestamp. */
  createdAt: number;
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

/** Relative timestamp for thread rows: just now / 5m ago / 15h ago / 3d ago. */
function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ChatSurface({
  token,
  defaultCwd,
  onActiveSessionChange,
}: {
  token: string | null;
  /** The app's active cwd (from /api/config) — seeds the auto-created first
   *  project so a fresh boot is immediately usable without a picker trip. */
  defaultCwd: string | null;
  /** Reports the ACTIVE thread's Claude session id up to the shell (US-012)
   *  so session-scoped concerns (native notifications) follow the thread the
   *  user is looking at — the chat-era replacement for pty correlation. */
  onActiveSessionChange?: (sessionId: string | null) => void;
}) {
  const seq = useRef(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ThreadUiState>>({});
  const [collapsed, setCollapsed] = useState(false);
  /** Per-project group collapse (chevron). Absent/false = expanded. */
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  /** In-app folder browser open (the non-Tauri Browse fallback). */
  const [pickingFolder, setPickingFolder] = useState(false);

  // Tick every 30s so the relative timestamps stay honest while idle.
  const [, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  /** Add (or reuse — same path twice is one project) a project for a folder. */
  const addProject = (path: string): Project => {
    const clean = path.replace(/\/+$/, "") || "/";
    const existing = projects.find((p) => p.path === clean);
    if (existing) return existing;
    const proj: Project = { id: `p${++seq.current}`, path: clean, name: basename(clean) };
    setProjects((prev) => [...prev, proj]);
    return proj;
  };

  const newThreadIn = (projectId: string) => {
    const id = `t${++seq.current}`;
    setThreads((prev) => [...prev, { id, projectId, createdAt: Date.now() }]);
    setActiveId(id);
    // Make the new thread visible: a chat landing in a collapsed group (or a
    // collapsed sidebar) reads as "nothing happened" while a real agent
    // session quietly spawns.
    setClosedGroups((prev) => (prev[projectId] ? { ...prev, [projectId]: false } : prev));
    setCollapsed(false);
  };

  /** Add a project and open its first chat — the add-project flows land here
   *  so a project never appears without a visible, usable thread. */
  const addProjectAndChat = (path: string) => {
    newThreadIn(addProject(path).id);
  };

  /** Folder picker: native dialog under Tauri, in-app DirBrowser fallback
   *  (browser dev has no native dialogs) — same split the US-011 cwd picker
   *  used. */
  const pickProjectFolder = async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({
        directory: true,
        defaultPath: defaultCwd ?? undefined,
        title: "Choose a project folder",
      });
      if (typeof dir === "string" && dir) addProjectAndChat(dir);
    } else {
      setPickingFolder(true);
    }
  };

  /** New chat with no explicit project (File ▸ New Chat, empty states): the
   *  active thread's project, else the first project, else auto-create one
   *  from the app's cwd — a thread never exists without a home (US-025). */
  const newThreadSomewhere = () => {
    const activeProject = activeId
      ? threads.find((t) => t.id === activeId)?.projectId
      : undefined;
    const target = activeProject ?? projects[0]?.id;
    if (target) newThreadIn(target);
    else if (defaultCwd) addProjectAndChat(defaultCwd);
    else void pickProjectFolder();
  };

  // Boot: auto-create a project from the app's active cwd with one draft
  // thread, so the surface is immediately usable. Waits for /api/config to
  // deliver the cwd (it loads async); skipped if the user beat it to the
  // add-project button.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || !defaultCwd) return;
    booted.current = true;
    if (projects.length === 0) addProjectAndChat(defaultCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCwd]);

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
  // the handlers close over threads/projects/activeId, so re-subscribing per
  // render keeps them current.
  useEffect(() => {
    const onNew = () => newThreadSomewhere();
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

  const projectPath = (projectId: string): string | null =>
    projects.find((p) => p.id === projectId)?.path ?? null;

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
          {/* No new-chat/add-project buttons while collapsed: creating either
              here lands in a hidden list, which reads as "nothing happened"
              and silently stacks up processes. Expand first — one click. */}
        </div>
      ) : (
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
            <span className="flex-1 text-[11px] font-medium text-muted-foreground">
              Projects
            </span>
            <IconButton title="Add project" onClick={() => void pickProjectFolder()}>
              <FolderPlus className="size-4" />
            </IconButton>
            <IconButton title="Collapse sidebar" onClick={() => setCollapsed(true)}>
              <PanelLeftClose className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {projects.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground">
                No projects yet — add a folder to start chatting.
              </p>
            ) : (
              projects.map((proj) => {
                const list = threads.filter((t) => t.projectId === proj.id);
                const closed = closedGroups[proj.id] === true;
                return (
                  <div key={proj.id} className="mb-1">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        title={proj.path}
                        onClick={() =>
                          setClosedGroups((prev) => ({ ...prev, [proj.id]: !closed }))
                        }
                        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      >
                        {closed ? (
                          <ChevronRight className="size-3 shrink-0" />
                        ) : (
                          <ChevronDown className="size-3 shrink-0" />
                        )}
                        <Folder className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wide">
                          {proj.name}
                        </span>
                      </button>
                      <IconButton
                        title={`New chat in ${proj.name}`}
                        onClick={() => newThreadIn(proj.id)}
                      >
                        <MessageSquarePlus className="size-3.5" />
                      </IconButton>
                    </div>
                    {!closed &&
                      (list.length === 0 ? (
                        <p className="py-1 pl-5 pr-2 text-[11px] text-muted-foreground/70">
                          No chats yet.
                        </p>
                      ) : (
                        <div className="ml-2.5 border-l border-border pl-1">
                          {list.map((t) => (
                            <ThreadRow
                              key={t.id}
                              title={states[t.id]?.title ?? null}
                              when={timeAgo(t.createdAt)}
                              pill={pillOf(states[t.id])}
                              active={t.id === activeId}
                              onSelect={() => setActiveId(t.id)}
                              onClose={() => closeThread(t.id)}
                            />
                          ))}
                        </div>
                      ))}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}

      {/* Thread panes — all mounted, only the active one visible/interactive. */}
      <div className="relative min-h-0 min-w-0 flex-1">
        {threads.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <p className="text-sm">
              {projects.length === 0 ? "Add a project to start chatting." : "No open chats."}
            </p>
            <button
              onClick={() =>
                projects.length === 0 ? void pickProjectFolder() : newThreadSomewhere()
              }
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {projects.length === 0 ? "Add project" : "New chat"}
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
              cwd={projectPath(t.projectId) ?? defaultCwd}
              onState={(s) => reportState(t.id, s)}
            />
          </div>
        ))}
        </div>
      </div>

      {pickingFolder && (
        <DirBrowser
          token={token}
          start={defaultCwd}
          title="Choose a project folder"
          onSelect={(p) => {
            addProjectAndChat(p);
            setPickingFolder(false);
          }}
          onClose={() => setPickingFolder(false)}
        />
      )}
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
  when,
  pill,
  active,
  onSelect,
  onClose,
}: {
  title: string | null;
  /** Relative creation time, e.g. "just now" / "15h ago". */
  when: string;
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
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs" title={title ?? "New chat"}>
          {title ?? "New chat"}
        </span>
        <span className="block text-[10px] text-muted-foreground/70">{when}</span>
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
