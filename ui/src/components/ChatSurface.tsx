import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  X,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import ChatPane, { type ThreadUiState } from "./ChatPane.tsx";
import type { SkillFiredEvent } from "../hooks/useTasks.ts";
import { basename } from "./DirBrowser.tsx";
import ProjectPicker, { recordRecentProject } from "./ProjectPicker.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { apiBase } from "../lib/gateway.ts";
import { cn } from "../lib/utils.ts";
import { useProviders, type ProviderStatus } from "../hooks/useProviders.ts";
import { PROVIDER_ICON } from "./ProviderMark.tsx";

/**
 * Project-organized chat surface (US-006 sidebar shell, US-025 projects,
 * US-014 persistence): a collapsible left sidebar of Projects — each a
 * first-class {id, path, name} created from a folder picker — with their chat
 * threads nested beneath, beside the active thread's ChatPane.
 *
 * A Thread BELONGS to a project and inherits the project's path as its cwd;
 * there is no per-thread directory divergence (that would make the grouping
 * lie). Each live thread owns its own ChatPane — and therefore its own
 * useAgentChat WS + headless `claude` process. Live threads stay MOUNTED when
 * inactive (hidden via visibility/z-index, the same pattern App.tsx used for
 * the terminal-era surfaces) so switching never tears down a running turn.
 *
 * Persistence (US-014): projects and thread metadata live in the gateway's
 * SQLite (`GET/POST /api/agent/projects`, thread rows upserted at session
 * init) and survive reloads + gateway restarts. The sidebar renders the
 * persisted list merged with live threads — a live thread whose session is
 * already persisted renders once, with the DB's title/last-activity. Selecting
 * a saved thread from a previous run REOPENS it (US-015): a live pane
 * reconstructs the transcript from Claude's JSONL and the next prompt resumes
 * the session (`--resume`). Closing any thread deletes its row; a project
 * with no threads persists.
 */

/** First-class project: a chosen folder that chats live inside (US-025).
 *  Ids come from the gateway's project table (stable across reloads). */
interface Project {
  id: string;
  /** Absolute path of the project folder — every thread's cwd. */
  path: string;
  /** Display name: the folder basename. */
  name: string;
  /** Creation time — the "Created" project sort key (US-005). */
  createdAt: number;
  /** Git repo root containing the folder (gateway-computed) — the
   *  group-by-repository key. Null/absent = not in a repo (groups by path). */
  repoRoot?: string | null;
}

/** A live (this-run) thread hosting a mounted ChatPane. */
interface Thread {
  id: string;
  projectId: string;
  /** Creation time, for the sidebar's relative timestamp until the thread's
   *  persisted row (keyed by session id) supplies last_activity. */
  createdAt: number;
  /** The saved thread this pane reopens (US-015) — its transcript restores
   *  and the first prompt resumes its session. Absent for fresh chats. */
  resume?: SavedThread;
}

/** A persisted chat_thread row from GET /api/agent/projects (US-014). */
interface SavedThread {
  sessionId: string;
  cwd: string;
  model: string | null;
  /** Agent provider that drove the thread (T3-1 US-006/008) — 'claude' |
   *  'codex' | 'grok'; the gateway coalesces pre-migration nulls to 'claude'. */
  provider: string | null;
  effort: string | null;
  title: string | null;
  /** PD-1: last assistant response / prompt preview — the row's description. */
  lastMessage: string | null;
  createdAt: number;
  lastActivity: number;
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

// ── Sidebar sort / group preferences (US-005) ──────────────────────────────

type ProjectSort = "activity" | "created" | "manual";
type ThreadSort = "activity" | "created";
type ProjectGroup = "repo" | "path" | "separate";

/** The ↑↓ menu's selections, persisted to localStorage across reloads. */
interface SidebarView {
  projectSort: ProjectSort;
  threadSort: ThreadSort;
  /** Max thread rows shown per project before a "Show more" affordance.
   *  Open (live) chats always show — the cap only trims saved history. */
  visibleThreads: number;
  group: ProjectGroup;
  /** Explicit project order for projectSort="manual" (ids; projects not yet
   *  placed append in activity order). Reordered via the row ↑/↓ buttons. */
  manualOrder: string[];
}

const VIEW_KEY = "conan-sidebar-view";
const VISIBLE_MIN = 1;
const VISIBLE_MAX = 20;
const DEFAULT_VIEW: SidebarView = {
  projectSort: "activity",
  threadSort: "activity",
  visibleThreads: 5,
  group: "repo",
  manualOrder: [],
};

function loadView(): SidebarView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return DEFAULT_VIEW;
    const v = JSON.parse(raw) as Partial<SidebarView>;
    return {
      projectSort:
        v.projectSort === "created" || v.projectSort === "manual"
          ? v.projectSort
          : "activity",
      threadSort: v.threadSort === "created" ? "created" : "activity",
      visibleThreads: Math.min(
        VISIBLE_MAX,
        Math.max(VISIBLE_MIN, Math.round(Number(v.visibleThreads)) || DEFAULT_VIEW.visibleThreads),
      ),
      group: v.group === "path" || v.group === "separate" ? v.group : "repo",
      manualOrder: Array.isArray(v.manualOrder)
        ? v.manualOrder.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

/** Parent directory of an absolute path — the group-by-path key. */
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

export default function ChatSurface({
  token,
  defaultCwd,
  lastSkillFired,
  onActiveSessionChange,
}: {
  token: string | null;
  /** The app's active cwd (from /api/config) — seeds the auto-created first
   *  project so a fresh boot is immediately usable without a picker trip. */
  defaultCwd: string | null;
  /** Latest `{type:'skill-fired'}` app-WS broadcast (US-017), fanned out to
   *  every pane — each filters by its own session id for its activity spine. */
  lastSkillFired?: SkillFiredEvent | null;
  /** Reports the ACTIVE thread's Claude session id up to the shell (US-012)
   *  so session-scoped concerns (native notifications) follow the thread the
   *  user is looking at — the chat-era replacement for pty correlation. */
  onActiveSessionChange?: (sessionId: string | null) => void;
}) {
  const seq = useRef(0);
  const [projects, setProjects] = useState<Project[]>([]);
  /** Persisted threads by project id, newest activity first (US-014). */
  const [saved, setSaved] = useState<Record<string, SavedThread[]>>({});
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ThreadUiState>>({});
  /** Registry rows (US-011) — resolve each thread's provider id to its
   *  avatar letter + display name. Shares ChatPane's module-cached fetch. */
  const providers = useProviders(token);
  const [collapsed, setCollapsed] = useState(false);
  /** Per-project group collapse (chevron). Absent/false = expanded. */
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  /** Add-project Sources palette open (US-006). */
  const [pickingFolder, setPickingFolder] = useState(false);
  /** Sort/group prefs (US-005) — localStorage-backed so they survive reloads. */
  const [view, setView] = useState<SidebarView>(loadView);
  /** Projects whose saved-thread list is expanded past the visible cap.
   *  Session-only — a reload re-collapses to the cap. */
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* private-mode storage failures just lose persistence, not the UI */
    }
  }, [view]);

  const patchView = (p: Partial<SidebarView>) => setView((v) => ({ ...v, ...p }));

  // Tick every 30s so the relative timestamps stay honest while idle.
  const [, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  /** Pull the persisted projects + threads (US-014). Returns the fetched
   *  projects (with their saved threads — the boot auto-open needs them), or
   *  null when the gateway was unreachable. Local-only fallback projects (a
   *  failed POST) are kept, appended after the server's order. */
  const refresh = useCallback(async (): Promise<
    Array<Project & { threads: SavedThread[] }> | null
  > => {
    if (!token) return null;
    try {
      const r = await fetch(apiBase() + "/api/agent/projects", {
        headers: { "x-conan-token": token },
      });
      if (!r.ok) return null;
      const data = (await r.json()) as {
        projects: Array<Project & { threads: SavedThread[] }>;
      };
      setProjects((prev) => {
        const server: Project[] = data.projects.map(
          ({ id, path, name, createdAt, repoRoot }) => ({ id, path, name, createdAt, repoRoot }),
        );
        const extras = prev.filter((p) => !server.some((s) => s.path === p.path));
        return [...server, ...extras];
      });
      setSaved(Object.fromEntries(data.projects.map((p) => [p.id, p.threads])));
      return data.projects;
    } catch {
      return null;
    }
  }, [token]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  /** Add (or reuse — same path twice is one project) a project for a folder.
   *  Persists via POST /api/agent/projects; degrades to an ephemeral local
   *  project when the gateway can't be reached, so chatting still works. */
  const addProject = async (path: string): Promise<Project> => {
    const clean = path.replace(/\/+$/, "") || "/";
    recordRecentProject(clean);
    const existing = projects.find((p) => p.path === clean);
    if (existing) return existing;
    if (token) {
      try {
        const r = await fetch(apiBase() + "/api/agent/projects", {
          method: "POST",
          headers: { "content-type": "application/json", "x-conan-token": token },
          body: JSON.stringify({ path: clean }),
        });
        if (r.ok) {
          const row = (await r.json()) as Project;
          // repoRoot arrives on the next list refresh; until then the project
          // groups by its own path.
          const proj: Project = {
            id: row.id,
            path: row.path,
            name: row.name,
            createdAt: row.createdAt ?? Date.now(),
          };
          setProjects((prev) =>
            prev.some((p) => p.id === proj.id) ? prev : [...prev, proj],
          );
          return proj;
        }
      } catch {
        /* fall through to the local fallback */
      }
    }
    const proj: Project = {
      id: `local-${++seq.current}`,
      path: clean,
      name: basename(clean),
      createdAt: Date.now(),
    };
    setProjects((prev) => [...prev, proj]);
    return proj;
  };

  const newThreadIn = (projectId: string) => {
    // T3-11: reuse this project's existing untouched draft instead of stacking
    // another one. A draft is untouched when it has never reported a session id
    // (no turn has been sent, so no `chat_thread` row exists either) and it
    // isn't reopening a saved thread. Without this, three clicks of "New chat"
    // left three identical empty rows in the sidebar.
    const draft = threads.find(
      (t) => t.projectId === projectId && !t.resume && !states[t.id]?.sessionId,
    );
    if (draft) {
      setActiveId(draft.id);
      setClosedGroups((prev) => (prev[projectId] ? { ...prev, [projectId]: false } : prev));
      setCollapsed(false);
      return;
    }
    const id = `t${++seq.current}`;
    setThreads((prev) => [...prev, { id, projectId, createdAt: Date.now() }]);
    setActiveId(id);
    // Make the new thread visible: a chat landing in a collapsed group (or a
    // collapsed sidebar) reads as "nothing happened" while a real agent
    // session quietly spawns.
    setClosedGroups((prev) => (prev[projectId] ? { ...prev, [projectId]: false } : prev));
    setCollapsed(false);
  };

  /** Reopen a saved thread (US-015): mount a live pane that restores the
   *  transcript and resumes the session on the next prompt. A pane already
   *  reopening this session is focused instead of duplicated. */
  const openSavedThread = (projectId: string, s: SavedThread) => {
    const existing = threads.find((t) => t.resume?.sessionId === s.sessionId);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const id = `t${++seq.current}`;
    setThreads((prev) => [...prev, { id, projectId, createdAt: s.createdAt, resume: s }]);
    setActiveId(id);
  };

  /** Add a project and open its first chat — the add-project flows land here
   *  so a project never appears without a visible, usable thread. */
  const addProjectAndChat = async (path: string) => {
    newThreadIn((await addProject(path)).id);
  };

  /** Add-project flow (US-006): the keyboard-navigable Sources palette —
   *  Local folder browse + recent projects — replacing the raw OS folder
   *  dialog (and the old DirBrowser fallback) on every platform. */
  const pickProjectFolder = async () => {
    setPickingFolder(true);
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
    else if (defaultCwd) void addProjectAndChat(defaultCwd);
    else void pickProjectFolder();
  };

  // Boot: load the persisted projects + threads first (US-014). Only when the
  // store is empty (first run / fresh DB) auto-create a project from the
  // app's active cwd with one draft thread, so a brand-new install is
  // immediately usable. A returning user's most-recent saved thread reopens
  // automatically (US-002) — persistence should look like persistence, not an
  // empty "No open chats" pane. Boot-only: explicitly closing every thread
  // later does NOT re-trigger this (booted guards it), so the empty state
  // still honors a deliberate close-all.
  const booted = useRef(false);
  const projectCount = useRef(0);
  projectCount.current = projects.length;
  const threadCount = useRef(0);
  threadCount.current = threads.length;
  useEffect(() => {
    if (booted.current || !defaultCwd || !token) return;
    booted.current = true;
    void (async () => {
      const loaded = await refreshRef.current();
      if (!loaded?.length) {
        if (projectCount.current === 0) await addProjectAndChat(defaultCwd);
        return;
      }
      const newest = loaded
        .flatMap((p) => p.threads.map((s) => ({ projectId: p.id, thread: s })))
        .sort((a, b) => b.thread.lastActivity - a.thread.lastActivity)[0];
      // Skip if the user already opened something while the fetch was in
      // flight — auto-open must never steal focus from an explicit action.
      if (newest && threadCount.current === 0) {
        openSavedThread(newest.projectId, newest.thread);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultCwd, token]);

  // Per-thread state reports from hidden panes drive the pills. Bail when
  // nothing changed so re-reports from parent re-renders can't loop. A
  // busy→idle transition means a turn just completed — re-pull the persisted
  // list so titles + last_activity stay fresh (US-014).
  const statesRef = useRef(states);
  statesRef.current = states;
  const reportState = useCallback((id: string, s: ThreadUiState) => {
    if (statesRef.current[id]?.busy === true && !s.busy) void refreshRef.current();
    setStates((prev) => {
      const cur = prev[id];
      if (
        cur &&
        cur.status === s.status &&
        cur.busy === s.busy &&
        cur.awaitingApproval === s.awaitingApproval &&
        cur.title === s.title &&
        cur.sessionId === s.sessionId &&
        cur.provider === s.provider
      ) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** Delete a thread's persisted row (close-X on any thread — US-014). */
  const deleteSavedRow = async (sessionId: string) => {
    if (token) {
      try {
        await fetch(apiBase() + `/api/agent/threads/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers: { "x-conan-token": token },
        });
      } catch {
        /* best-effort — the row will resurface on the next refresh if not */
      }
    }
    void refreshRef.current();
  };

  const closeThread = (id: string) => {
    // Closing a live chat also deletes its persisted row (US-014) — closing
    // IS the delete gesture; a reload (no close) keeps threads listed. A
    // reopened pane that hasn't taken a turn yet still owns its SAVED row.
    const sid =
      states[id]?.sessionId ?? threads.find((t) => t.id === id)?.resume?.sessionId;
    if (sid) void deleteSavedRow(sid);
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

  // US-003: the sidebar gear opens Settings via the same window-event bridge
  // the native menu (⌘,) and the Upgrade CTAs use — App owns the dialog state.
  const openSettings = () =>
    window.dispatchEvent(new CustomEvent("conan:open-settings"));

  // ── US-005: sort + group the sidebar per the ↑↓ menu ─────────────────────

  /** Newest activity a project has seen: saved-thread activity, live drafts
   *  opened this run, else its creation time. */
  const projActivity = (p: Project): number =>
    Math.max(
      p.createdAt,
      ...(saved[p.id] ?? []).map((s) => s.lastActivity),
      ...threads.filter((t) => t.projectId === p.id).map((t) => t.createdAt),
    );

  const orderedProjects = (() => {
    const base = [...projects];
    if (view.projectSort === "created") {
      base.sort((a, b) => b.createdAt - a.createdAt);
      return base;
    }
    base.sort((a, b) => projActivity(b) - projActivity(a));
    if (view.projectSort !== "manual") return base;
    // Manual: explicit placements first, unplaced projects trail in activity
    // order (they slot into manualOrder on the first ↑/↓ press).
    const rank = new Map(view.manualOrder.map((id, i) => [id, i]));
    return [
      ...base
        .filter((p) => rank.has(p.id))
        .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
      ...base.filter((p) => !rank.has(p.id)),
    ];
  })();

  /** Swap a project with its display neighbor (manual sort's ↑/↓ buttons) and
   *  persist the WHOLE displayed order, so every project gets a stable slot. */
  const moveProject = (id: string, dir: -1 | 1) => {
    const order = orderedProjects.map((p) => p.id);
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const a = order[i]!;
    order[i] = order[j]!;
    order[j] = a;
    patchView({ manualOrder: order });
  };

  /** Cluster key per the Group-projects mode. "Keep separate" makes every
   *  project its own cluster (today's flat rendering). */
  const groupKeyOf = (p: Project): string =>
    view.group === "separate"
      ? p.id
      : view.group === "path"
        ? parentDir(p.path)
        : p.repoRoot ?? p.path;

  // Clusters keep the sorted order (a cluster sits where its first member
  // ranks); a header label only renders when ≥2 projects actually share the
  // key, so the common one-repo-per-project case looks exactly like today.
  const projectGroups = (() => {
    const groups: { key: string; members: Project[] }[] = [];
    const at = new Map<string, number>();
    for (const p of orderedProjects) {
      const k = groupKeyOf(p);
      const idx = at.get(k);
      if (idx == null) {
        at.set(k, groups.length);
        groups.push({ key: k, members: [p] });
      } else {
        groups[idx]!.members.push(p);
      }
    }
    return groups;
  })();

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
          <div className="mt-auto flex h-9 shrink-0 items-center">
            <IconButton title="Settings" onClick={openSettings}>
              <Settings className="size-4" />
            </IconButton>
          </div>
        </div>
      ) : (
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
            <span className="flex-1 text-[11px] font-medium text-muted-foreground">
              Projects
            </span>
            <SortGroupMenu view={view} onPatch={patchView} />
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
              projectGroups.map((g) => (
                <div key={g.key}>
                  {/* US-005: a cluster label only when ≥2 projects share the
                      repo/parent — the common case renders exactly as before. */}
                  {g.members.length > 1 && (
                    <div
                      className="truncate px-1 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60"
                      title={g.key}
                    >
                      {basename(g.key)}
                    </div>
                  )}
                  {g.members.map((proj) => {
                const list = threads.filter((t) => t.projectId === proj.id);
                const savedAll = saved[proj.id] ?? [];
                const bySession = new Map(savedAll.map((s) => [s.sessionId, s]));
                // A live thread whose session is persisted — or which is
                // REOPENING a saved session (US-015) — renders ONCE, as the
                // live row (with the DB's fresher activity time).
                const liveSessions = new Set(
                  list.flatMap((t) =>
                    [states[t.id]?.sessionId, t.resume?.sessionId].filter(Boolean),
                  ),
                );
                const savedOnly = savedAll.filter((s) => !liveSessions.has(s.sessionId));
                // US-005: thread sort + the visible cap. Live (open) rows
                // always show — the cap only trims saved history, since
                // hiding an open chat would hide a running agent process.
                const liveRows = list
                  .map((t) => {
                    const sid = states[t.id]?.sessionId;
                    const row =
                      (sid ? bySession.get(sid) : undefined) ??
                      (t.resume ? bySession.get(t.resume.sessionId) : undefined);
                    // A reopened thread keeps its saved title until a fresh
                    // live one exists (DB titles are sticky).
                    const title = t.resume
                      ? row?.title ?? t.resume.title ?? states[t.id]?.title ?? null
                      : states[t.id]?.title ?? row?.title ?? null;
                    return {
                      t,
                      title,
                      activity: row?.lastActivity ?? t.createdAt,
                      desc: row?.lastMessage ?? t.resume?.lastMessage ?? null,
                      // US-011: the live pane's report is freshest (a fresh
                      // thread's chip pick shows before the row persists),
                      // then the persisted row, then the reopened target.
                      provider:
                        states[t.id]?.provider ??
                        row?.provider ??
                        t.resume?.provider ??
                        null,
                    };
                  })
                  .sort((a, b) =>
                    view.threadSort === "created"
                      ? b.t.createdAt - a.t.createdAt
                      : b.activity - a.activity,
                  );
                const sortedSaved = [...savedOnly].sort((a, b) =>
                  view.threadSort === "created"
                    ? b.createdAt - a.createdAt
                    : b.lastActivity - a.lastActivity,
                );
                const savedCap = Math.max(0, view.visibleThreads - liveRows.length);
                const expanded = expandedThreads[proj.id] === true;
                const visibleSaved = expanded ? sortedSaved : sortedSaved.slice(0, savedCap);
                const hiddenCount = sortedSaved.length - visibleSaved.length;
                const closed = closedGroups[proj.id] === true;
                return (
                  <div key={proj.id} className="mb-1">
                    <div className="group flex items-center gap-0.5">
                      <button
                        type="button"
                        title={proj.path}
                        onClick={() =>
                          setClosedGroups((prev) => ({ ...prev, [proj.id]: !closed }))
                        }
                        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      {/* Reveal on project-row hover (or keyboard focus within
                          the row), matching t3-code — not always shown. */}
                      <span className="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {/* US-005: manual sort exposes ↑/↓ on hover — the
                            explicit reorder gesture behind "Manual". */}
                        {view.projectSort === "manual" && (
                          <>
                            <IconButton
                              title={`Move ${proj.name} up`}
                              onClick={() => moveProject(proj.id, -1)}
                            >
                              <ArrowUp className="size-3" />
                            </IconButton>
                            <IconButton
                              title={`Move ${proj.name} down`}
                              onClick={() => moveProject(proj.id, 1)}
                            >
                              <ArrowDown className="size-3" />
                            </IconButton>
                          </>
                        )}
                        <IconButton
                          title={`New chat in ${proj.name}`}
                          onClick={() => newThreadIn(proj.id)}
                        >
                          <MessageSquarePlus className="size-3.5" />
                        </IconButton>
                      </span>
                    </div>
                    {!closed &&
                      (list.length === 0 && savedOnly.length === 0 ? (
                        <p className="py-1 pl-5 pr-2 text-[11px] text-muted-foreground/70">
                          No chats yet.
                        </p>
                      ) : (
                        <div className="ml-2.5 border-l border-border pl-1">
                          {liveRows.map(({ t, title, activity, desc, provider }) => (
                            <ThreadRow
                              key={t.id}
                              title={title}
                              desc={desc}
                              when={timeAgo(activity)}
                              pill={pillOf(states[t.id])}
                              agent={agentOf(provider, providers)}
                              active={t.id === activeId}
                              onSelect={() => setActiveId(t.id)}
                              onClose={() => closeThread(t.id)}
                            />
                          ))}
                          {visibleSaved.map((s) => (
                            <ThreadRow
                              key={s.sessionId}
                              title={s.title}
                              desc={s.lastMessage}
                              when={timeAgo(s.lastActivity)}
                              pill="idle"
                              agent={agentOf(s.provider, providers)}
                              active={false}
                              onSelect={() => openSavedThread(proj.id, s)}
                              onClose={() => void deleteSavedRow(s.sessionId)}
                            />
                          ))}
                          {hiddenCount > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedThreads((prev) => ({ ...prev, [proj.id]: true }))
                              }
                              className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Show {hiddenCount} more…
                            </button>
                          )}
                          {expanded && sortedSaved.length > savedCap && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedThreads((prev) => ({ ...prev, [proj.id]: false }))
                              }
                              className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Show less
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                );
                  })}
                </div>
              ))
            )}
          </div>
          {/* US-003: standard chat-app Settings placement — bottom of the rail.
              Same window-event bridge the native menu uses, so it works in the
              browser too (where the Tauri menu doesn't exist). */}
          <div className="flex h-9 shrink-0 items-center border-t border-border px-2">
            <IconButton title="Settings" onClick={openSettings}>
              <Settings className="size-4" />
            </IconButton>
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
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
              projectId={t.projectId}
              resume={
                t.resume
                  ? {
                      sessionId: t.resume.sessionId,
                      model: t.resume.model,
                      provider: t.resume.provider ?? null,
                      effort: t.resume.effort,
                    }
                  : null
              }
              lastSkillFired={lastSkillFired}
              onState={(s) => reportState(t.id, s)}
            />
          </div>
        ))}
        </div>
      </div>

      {pickingFolder && (
        <ProjectPicker
          token={token}
          start={defaultCwd}
          onSelect={(p) => {
            void addProjectAndChat(p);
            setPickingFolder(false);
          }}
          onClose={() => setPickingFolder(false)}
        />
      )}
    </section>
  );
}

/** The sidebar header's ↑↓ menu (US-005): sort projects / sort threads /
 *  visible-thread cap / group projects. Radio picks keep the menu open so a
 *  user can adjust several axes in one visit; every change applies live and
 *  persists via the caller's localStorage-backed view state. */
function SortGroupMenu({
  view,
  onPatch,
}: {
  view: SidebarView;
  onPatch: (p: Partial<SidebarView>) => void;
}) {
  const stepVisible = (d: number) =>
    onPatch({
      visibleThreads: Math.min(VISIBLE_MAX, Math.max(VISIBLE_MIN, view.visibleThreads + d)),
    });
  const keepOpen = (e: Event) => e.preventDefault();
  const labelCls = "px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground";
  const itemCls = "py-1 text-xs";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Sort & group"
          aria-label="Sort & group"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowUpDown className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className={labelCls}>Sort projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.projectSort}
          onValueChange={(v) => onPatch({ projectSort: v as ProjectSort })}
        >
          <DropdownMenuRadioItem value="activity" onSelect={keepOpen} className={itemCls}>
            Last activity
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created" onSelect={keepOpen} className={itemCls}>
            Created
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="manual" onSelect={keepOpen} className={itemCls}>
            Manual
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={labelCls}>Sort threads</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.threadSort}
          onValueChange={(v) => onPatch({ threadSort: v as ThreadSort })}
        >
          <DropdownMenuRadioItem value="activity" onSelect={keepOpen} className={itemCls}>
            Last activity
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created" onSelect={keepOpen} className={itemCls}>
            Created
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={labelCls}>Visible threads</DropdownMenuLabel>
        <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
          <span className="text-xs text-muted-foreground">Per project</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Fewer visible threads"
              disabled={view.visibleThreads <= VISIBLE_MIN}
              onClick={() => stepVisible(-1)}
              className="flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Minus className="size-3" />
            </button>
            <span className="w-6 text-center text-xs tabular-nums">{view.visibleThreads}</span>
            <button
              type="button"
              aria-label="More visible threads"
              disabled={view.visibleThreads >= VISIBLE_MAX}
              onClick={() => stepVisible(1)}
              className="flex size-5 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-3" />
            </button>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={labelCls}>Group projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.group}
          onValueChange={(v) => onPatch({ group: v as ProjectGroup })}
        >
          <DropdownMenuRadioItem value="repo" onSelect={keepOpen} className={itemCls}>
            By repository
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="path" onSelect={keepOpen} className={itemCls}>
            By path
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="separate" onSelect={keepOpen} className={itemCls}>
            Keep separate
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** PD-1: status icon (left) per thread state, theme-token coloured. Ready/idle
 *  read as a check/dot; working spins; awaiting-approval alerts. */
const STATUS_ICON: Record<Pill, { Icon: LucideIcon; cls: string; spin?: boolean }> = {
  working: { Icon: Loader2, cls: "text-primary", spin: true },
  awaiting: { Icon: AlertTriangle, cls: "text-amber-500 dark:text-amber-400" },
  ready: { Icon: CheckCircle2, cls: "text-chart-2" },
  idle: { Icon: Circle, cls: "text-muted-foreground/40" },
};

/** The coding agent behind a thread (US-011): the persisted provider id
 *  resolved against the registry (`GET /api/agent/providers`). No stored
 *  provider (pre-migration rows) → Claude; an id the registry hasn't served
 *  yet falls back to its capitalized first letter, mirroring ChatPane's
 *  provider-chip fallback. */
function agentOf(
  provider: string | null | undefined,
  registry: ProviderStatus[],
): { id: string; letter: string; label: string } {
  const id = provider ?? "claude";
  const entry = registry.find((p) => p.id === id);
  if (entry) return { id, letter: entry.avatarLetter, label: entry.name };
  if (id === "claude") return { id, letter: "C", label: "Claude Code" };
  return {
    id,
    letter: id.charAt(0).toUpperCase(),
    label: id.charAt(0).toUpperCase() + id.slice(1),
  };
}

/** Sidebar row leading glyph: an avatar for which agent drove the thread (C /
 *  X / G) with the live status as a small corner badge — the verified-avatar
 *  pattern (identity + a status dot punched out with a ring). */
function AgentAvatar({
  pill,
  agent,
}: {
  pill: Pill;
  agent: { id: string; letter: string; label: string };
}) {
  const s = STATUS_ICON[pill];
  const icon = PROVIDER_ICON[agent.id];
  return (
    <span
      className="relative mt-0.5 shrink-0"
      title={`${agent.label} · ${PILL[pill].label}`}
      aria-label={`${agent.label}, ${PILL[pill].label}`}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-foreground ring-1 ring-border">
        {icon ? (
          <span
            className="flex size-3.5 items-center justify-center text-[14px] text-foreground [&>svg]:size-full"
            dangerouslySetInnerHTML={{ __html: icon }}
          />
        ) : (
          <span className="text-[11px] font-semibold">{agent.letter}</span>
        )}
      </span>
      <s.Icon
        className={cn(
          "absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-card ring-2 ring-card",
          s.cls,
          s.spin && "animate-spin",
        )}
      />
    </span>
  );
}

function ThreadRow({
  title,
  desc,
  when,
  pill,
  agent,
  active,
  onSelect,
  onClose,
}: {
  title: string | null;
  /** PD-1: description line — last assistant response / prompt preview. */
  desc: string | null;
  /** Relative activity time, e.g. "just now" / "15h ago". */
  when: string;
  pill: Pill;
  /** Registry-resolved agent identity (US-011) — picks the avatar letter. */
  agent: { id: string; letter: string; label: string };
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const p = PILL[pill];
  // Attention states (Working / Awaiting) show a badge; settled states show
  // the timestamp — mirrors the reference (badge on warn/action, time on ok).
  const attention = pill === "working" || pill === "awaiting";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <AgentAvatar pill={pill} agent={agent} />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-xs font-medium text-foreground"
          title={title ?? "New chat"}
        >
          {title ?? "New chat"}
        </span>
        <span
          className="block truncate text-[10px] text-muted-foreground/70"
          title={desc ?? undefined}
        >
          {desc ?? "No messages yet"}
        </span>
      </span>
      {/* Right slot: close-X on hover, else badge (attention) / timestamp. */}
      <span className="relative flex shrink-0 items-center">
        {attention ? (
          <span
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium group-hover:opacity-0",
              p.cls,
            )}
          >
            <span className={cn("size-1.5 rounded-full", p.dot)} />
            {p.label}
          </span>
        ) : (
          <span className="whitespace-nowrap text-[10px] text-muted-foreground/60 group-hover:opacity-0">
            {when}
          </span>
        )}
        <button
          type="button"
          title="Close chat"
          aria-label="Close chat"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="absolute right-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  );
}
