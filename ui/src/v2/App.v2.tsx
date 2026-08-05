/**
 * Conan v2 — the shell. Paper artboard RJ-0 "Application Shell".
 *   https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/RJ-0
 *
 * COMPOSITION CONTRACT (docs/v2-astryx-redesign.md §4.4)
 * -----------------------------------------------------
 * T0 owns this file plus `Sidebar.tsx` and `Toolbar.tsx`. US-002…US-006 each own
 * ONE leaf under `components/` and touch nothing else; US-007 is the only later
 * story allowed back in here. That is what lets five worktrees run in parallel
 * without a merge conflict on the shell.
 *
 * p2a (US-201) re-enters here for the active-thread wiring seam: App.v2 owns
 * `activeThread` and passes selection callbacks into the sidebar. The content
 * well hosts V2ChatView instead of the shell-era placeholder.
 *
 * p2d (US-501) re-enters again — that is the phase's whole point (PRD
 * `compositionOwnership`). App.v2 now holds the SHELL'S DATA: real projects +
 * threads from `lib/useV2Projects.ts`, mapped into presentational props for the
 * sidebar. The leaves stay dumb; nothing under `components/` fetches.
 *
 * WHAT THE ARTBOARD SAYS
 * ----------------------
 * RJ-0 is 1512×1030 in two pieces: a 48px window title bar (RK-0) above a
 * 1512×982 app body (4I-0). The body is a 273px sidebar beside a main column of
 * toolbar → content well, and the well (4N-0) is the one lifted surface — one
 * step up in tone (#262626 against #1B1B1B) with a 24px top-LEFT corner only, so
 * it reads as a page tucked under the toolbar and against the sidebar. Getting
 * that single asymmetric corner right is most of what makes the shell look like
 * the design.
 *
 * WHY THERE IS NO TITLE BAR HERE
 * ------------------------------
 * RK-0 draws macOS traffic lights. Conan's Tauri window is NOT undecorated
 * (`src-tauri/tauri.conf.json` sets no `decorations: false`), so the real window
 * already has a native title bar — painting a second, non-functional one below it
 * would be a lie in the UI. RK-0 is read as the artboard's mock of that native
 * chrome and deliberately not rendered. Its one piece of genuine app UI, the
 * sidebar-collapse toggle, is a later task; the `--conan-color-titlebar` and
 * `--conan-control-*` tokens are already in `tokens.css` for the day we do go
 * undecorated.
 *
 * ASTRYX HOUSE RULES that apply here (from `ui/.claude/CLAUDE.md`):
 *   - no raw <div>: Layout / LayoutPanel / VStack / HStack do the structure
 *   - one `Layout` per shell, never nested
 *   - no Tailwind classes, no raw hex, no raw px — anything the props can't
 *     express goes through `xstyle` reading `tokens.css` (contract §4.2/§4.3)
 */
import { useCallback, useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Layout } from "@astryxdesign/core/Layout";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { VStack } from "@astryxdesign/core/VStack";
import { useHotkeys } from "@astryxdesign/core/hooks";
import Sidebar from "./Sidebar.tsx";
import Toolbar from "./Toolbar.tsx";
import SecondaryBar from "./components/SecondaryBar.tsx";
import RenameThreadDialog from "./components/RenameThreadDialog.tsx";
import AddProjectDialog from "./components/AddProjectDialog.tsx";
import V2CommandPalette from "./command/CommandPalette.tsx";
import V2ChatView from "./chat/V2ChatView.tsx";
import SurfaceWorkspace from "./components/SurfaceWorkspace.tsx";
import {
  SURFACE_OPTIONS,
  type SurfaceId,
  type SurfacePlacement,
  type SurfaceTab,
} from "./components/SurfaceTabs.tsx";
import { useGatewayConfig } from "./lib/useGatewayConfig.ts";
import {
  useV2Projects,
  type V2ProjectWithThreads,
  type V2SavedThread,
} from "./lib/useV2Projects.ts";
import type { ActiveThread } from "./lib/types.ts";
import { asProviderId } from "../chat/model.ts";
import type { ProjectGroup, ProjectTreeProps } from "./components/ProjectTree.tsx";
import type { ThreadRowProps } from "./components/ThreadRow.tsx";
import { pillOf, useV2ThreadState } from "./lib/useV2ThreadState.ts";
import { writeClipboardText } from "./lib/writeClipboardText.ts";
import { apiBase } from "../lib/gateway.ts";
import { MessagesSquare } from "lucide-react";

/**
 * `xstyle` is Astryx's per-component style escape hatch, and the reason this app
 * compiles StyleX (see the plugin in `vite.config.ts`). Astryx's own components
 * ship pre-compiled, but `stylex.create` in APP code throws at runtime unless a
 * build-time compiler rewrites it — verified in T0:
 *
 *   node -e "stylex.create({a:{color:'red'}})"
 *   → "Unexpected 'stylex.create' call at runtime. Styles must be compiled…"
 *
 * Every value below is a `tokens.css` variable, never a literal (contract §4.2).
 */
const styles = stylex.create({
  shell: {
    backgroundColor: "var(--conan-color-bg)",
  },
  // 4N-0 — the lifted content well. ONE rounded corner: top-left. The other
  // three meet the window edge, so rounding them would open gaps.
  well: {
    backgroundColor: "var(--conan-color-content)",
    borderLeftColor: "var(--conan-color-border)",
    borderLeftStyle: "solid",
    borderLeftWidth: "var(--conan-border-width)",
    borderStartStartRadius: "var(--conan-radius-page)",
    borderTopColor: "var(--conan-color-border)",
    borderTopStyle: "solid",
    borderTopWidth: "var(--conan-border-width)",
    boxSizing: "border-box",
    flexGrow: 1,
    minHeight: 0,
    overflow: "clip",
  },
});

// Provider narrowing is asProviderId in the shared chat model — checking
// against the REAL union (the local copy here once coerced kimi to claude).

/** v1's sidebar copy for a row the DB has no title/preview for yet. */
const UNTITLED = "New chat";
const NO_PREVIEW = "No messages yet";

interface V2Draft {
  id: string;
  projectId: string;
}

/** The project behind an open "Remove project?" confirmation (WHA-74). */
interface V2RemoveTarget {
  id: string;
  name: string;
}

/**
 * A client-only id for an unsent draft.
 *
 * `crypto.randomUUID` only exists in a SECURE CONTEXT. Tauri and localhost
 * qualify; a plain-http LAN origin (`http://192.168.x.x:5250` — how review
 * previews are actually opened) does not, and calling it there throws
 * "crypto.randomUUID is not a function" and kills the New chat click. Found
 * during WHA-74 browser QA. The fallback only has to be unique within one
 * session's draft list, so counter + timestamp is enough — this is never
 * persisted or used as a security value.
 */
let draftSeq = 0;
function draftId(): string {
  if (typeof crypto?.randomUUID === "function") return `draft-${crypto.randomUUID()}`;
  draftSeq += 1;
  return `draft-${Date.now().toString(36)}-${draftSeq}`;
}

export default function AppV2() {
  const config = useGatewayConfig();
  const token = config?.token ?? null;
  const { projects, loaded, error, refresh } = useV2Projects(token);
  const [activeThread, setActiveThread] = useState<ActiveThread | null>(null);
  const [drafts, setDrafts] = useState<V2Draft[]>([]);
  const [renameTarget, setRenameTarget] = useState<ThreadRowProps | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ThreadRowProps | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<V2RemoveTarget | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  // WHA-70 / US-401 — command palette open state lives at the shell once.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openSurfaces, setOpenSurfaces] = useState<
    Array<Exclude<SurfaceId, "chat">>
  >([]);
  const [activeSurface, setActiveSurface] = useState<SurfaceId>("chat");
  const [activeDockedSurface, setActiveDockedSurface] = useState<
    Exclude<SurfaceId, "chat"> | null
  >(null);
  const [surfacePlacements, setSurfacePlacements] = useState<
    Partial<Record<Exclude<SurfaceId, "chat">, SurfacePlacement>>
  >({});
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const { states, reportState } = useV2ThreadState();

  const surfaceTabs = useMemo<SurfaceTab[]>(
    () => {
      const dockedId =
        activeDockedSurface && surfacePlacements[activeDockedSurface]
          ? activeDockedSurface
          : openSurfaces.find((id) => surfacePlacements[id] != null) ?? null;
      const dockGroupActive =
        activeSurface !== "chat" && surfacePlacements[activeSurface] != null;
      const ordered = dockedId
        ? [dockedId, ...openSurfaces.filter((id) => id !== dockedId)]
        : openSurfaces;
      const dockedLabel = dockedId
        ? SURFACE_OPTIONS.find((candidate) => candidate.id === dockedId)?.label
        : null;
      return [
        {
        id: "chat",
        label: "Chat",
        icon: MessagesSquare,
        isSelected: activeSurface === "chat",
        isDocked: dockedId != null,
        isVisuallyActive: dockedId ? dockGroupActive : activeSurface === "chat",
        joinedSide: dockedId ? ("start" as const) : undefined,
        dockedDescription: dockedLabel ? `Joined with ${dockedLabel}` : undefined,
        },
      ...ordered.map((id) => {
        const surface = SURFACE_OPTIONS.find((candidate) => candidate.id === id)!;
        return {
          ...surface,
          placement: surfacePlacements[id],
          isSelected: activeSurface === id,
          isDocked: id === dockedId,
          isVisuallyActive:
            id === dockedId ? dockGroupActive : activeSurface === id,
          joinedSide: id === dockedId ? ("end" as const) : undefined,
          dockedDescription:
            id === dockedId
              ? `Docked ${surfacePlacements[id]} to Chat`
              : undefined,
        };
      }),
      ];
    },
    [activeDockedSurface, activeSurface, openSurfaces, surfacePlacements],
  );
  const openSurface = useCallback((id: Exclude<SurfaceId, "chat">) => {
    setOpenSurfaces((current) => (current.includes(id) ? current : [...current, id]));
    setActiveSurface(id);
  }, []);
  const selectSurface = useCallback(
    (id: SurfaceId) => {
      if (id === "chat") {
        const restoredDock =
          activeDockedSurface && surfacePlacements[activeDockedSurface]
            ? activeDockedSurface
            : openSurfaces.find((candidate) => surfacePlacements[candidate] != null);
        setActiveSurface(restoredDock ?? "chat");
        return;
      }
      if (surfacePlacements[id]) setActiveDockedSurface(id);
      setActiveSurface(id);
    },
    [activeDockedSurface, openSurfaces, surfacePlacements],
  );
  const closeSurface = useCallback((id: Exclude<SurfaceId, "chat">) => {
    setOpenSurfaces((current) => current.filter((candidate) => candidate !== id));
    setSurfacePlacements((current) => {
      const next = { ...current };
      delete next[id];
      setActiveDockedSurface((activeDock) =>
        activeDock === id
          ? openSurfaces.find((candidate) => candidate !== id && next[candidate] != null) ?? null
          : activeDock,
      );
      return next;
    });
    setActiveSurface((current) =>
      current === id
        ? activeDockedSurface && surfacePlacements[activeDockedSurface]
          ? activeDockedSurface
          : "chat"
        : current,
    );
  }, [activeDockedSurface, openSurfaces, surfacePlacements]);
  const changeSurfacePlacement = useCallback(
    (id: Exclude<SurfaceId, "chat">, placement: SurfacePlacement) => {
      setSurfacePlacements((current) => ({ ...current, [id]: placement }));
      setActiveDockedSurface(id);
      setActiveSurface(id);
    },
    [],
  );
  const undockSurface = useCallback((id: Exclude<SurfaceId, "chat">) => {
    setSurfacePlacements((current) => {
      const next = { ...current };
      delete next[id];
      setActiveDockedSurface((activeDock) =>
        activeDock === id
          ? openSurfaces.find((candidate) => candidate !== id && next[candidate] != null) ?? null
          : activeDock,
      );
      return next;
    });
    setActiveSurface(id);
  }, [openSurfaces]);

  // ⌘K / Ctrl+K opens the palette (allowInInputs: true so it works while the
  // composer or sidebar search is focused). Esc is owned by Astryx CommandPalette.
  useHotkeys([
    {
      keys: "mod+k",
      allowInInputs: true,
      onPress: openPalette,
    },
  ]);

  const copyText = useCallback((value: string) => {
    void writeClipboardText(value);
  }, []);

  const newThreadIn = useCallback(
    (projectId: string) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      const existing = drafts.find((draft) => draft.projectId === projectId);
      const id = existing?.id ?? draftId();
      if (!existing) setDrafts((current) => [...current, { id, projectId }]);
      setActiveThread({
        key: id,
        cwd: project.path,
        projectId,
        projectName: project.name,
        provider: "claude",
        title: UNTITLED,
      });
    },
    [drafts, projects],
  );

  const deleteThread = useCallback(
    async (row: ThreadRowProps) => {
      const id = row.id;
      if (!id) return;
      if (id.startsWith("draft-")) {
        setDrafts((current) => current.filter((draft) => draft.id !== id));
      } else if (token) {
        const response = await fetch(
          apiBase() + `/api/agent/threads/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            headers: { "x-conan-token": token },
          },
        );
        if (!response.ok) throw new Error(`Delete failed (${response.status})`);
        await refresh();
      }
      setActiveThread((current) => (current?.key === id ? null : current));
    },
    [refresh, token],
  );

  const requestDeleteThread = useCallback((row: ThreadRowProps) => {
    setDeleteError(false);
    setDeleteTarget(row);
  }, []);

  const confirmDeleteThread = useCallback(async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(false);
    try {
      await deleteThread(deleteTarget);
      setDeleteTarget(null);
    } catch {
      setDeleteError(true);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, deleteThread, isDeleting]);

  // WHA-74. The gateway's DELETE is metadata-only (`src/gateway/index.ts:603`):
  // it drops the project row and cascades its threads/actions, and never touches
  // the folder on disk. Drafts are client-only, so they are dropped here.
  const removeProject = useCallback(
    async ({ id }: V2RemoveTarget) => {
      if (!token) throw new Error("No gateway token");
      const response = await fetch(
        apiBase() + `/api/agent/projects/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { "x-conan-token": token },
        },
      );
      if (!response.ok) throw new Error(`Remove failed (${response.status})`);
      setDrafts((current) => current.filter((draft) => draft.projectId !== id));
      // The open thread may have belonged to the project that just went away.
      setActiveThread((current) => (current?.projectId === id ? null : current));
      await refresh();
    },
    [refresh, token],
  );

  // WHA-74 recovery path. Upsert is idempotent by path (`gateway/index.ts:585`),
  // so re-adding a folder returns its existing row rather than duplicating it.
  const addProject = useCallback(
    async (path: string) => {
      if (!token) throw new Error("No gateway token");
      const response = await fetch(apiBase() + "/api/agent/projects", {
        method: "POST",
        headers: {
          "x-conan-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) throw new Error(`Add failed (${response.status})`);
      await refresh();
    },
    [refresh, token],
  );

  const requestRemoveProject = useCallback((target: V2RemoveTarget) => {
    setRemoveError(false);
    setRemoveTarget(target);
  }, []);

  const confirmRemoveProject = useCallback(async () => {
    if (!removeTarget || isRemoving) return;
    setIsRemoving(true);
    setRemoveError(false);
    try {
      await removeProject(removeTarget);
      setRemoveTarget(null);
    } catch {
      setRemoveError(true);
    } finally {
      setIsRemoving(false);
    }
  }, [isRemoving, removeProject, removeTarget]);

  const saveThreadTitle = useCallback(
    async (title: string) => {
      const id = renameTarget?.id;
      if (!id || id.startsWith("draft-") || !token) {
        throw new Error("Thread is not renameable");
      }
      const response = await fetch(
        apiBase() + `/api/agent/threads/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            "x-conan-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title }),
        },
      );
      if (!response.ok) throw new Error(`Rename failed (${response.status})`);
      setActiveThread((current) =>
        current?.key === id ? { ...current, title } : current,
      );
      await refresh();
    },
    [refresh, renameTarget?.id, token],
  );

  // Presentational shape for the sidebar. Groups open by default: the gateway
  // already returns projects newest-activity-first, so the top of the tree is
  // the work you were last in. (Sort/group controls are US-504.)
  const groups: ProjectGroup[] = useMemo(
    () =>
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        isExpanded: true,
        onNewThread: () => newThreadIn(p.id),
        onRemove: () => requestRemoveProject({ id: p.id, name: p.name }),
        threads: [
          ...drafts
            .filter((draft) => draft.projectId === p.id)
            .map((draft): ThreadRowProps => ({
              id: draft.id,
              title: UNTITLED,
              subtitle: NO_PREVIEW,
              provider: "claude",
              status: pillOf(states[draft.id]),
              onNewThread: () => newThreadIn(p.id),
              onRename: null,
              onCopyPath: null,
              onCopyId: null,
              onDelete: () =>
                requestDeleteThread({
                  id: draft.id,
                  title: UNTITLED,
                  subtitle: NO_PREVIEW,
                }),
            })),
          ...p.threads.map((thread): ThreadRowProps => {
            const row: ThreadRowProps = {
              id: thread.sessionId,
              title: thread.title ?? UNTITLED,
              subtitle: thread.lastMessage ?? NO_PREVIEW,
              provider: asProviderId(thread.provider),
              status: pillOf(states[thread.sessionId]),
              lastActivity: thread.lastActivity,
            };
            return {
              ...row,
              onNewThread: () => newThreadIn(p.id),
              onRename: () => setRenameTarget(row),
              onCopyPath: () => copyText(thread.cwd || p.path),
              onCopyId: () => copyText(thread.sessionId),
              onDelete: () => requestDeleteThread(row),
            };
          }),
        ],
      })),
    [
      copyText,
      drafts,
      newThreadIn,
      projects,
      requestDeleteThread,
      requestRemoveProject,
      states,
    ],
  );

  // sessionId → its project + row, so a click can build the FULL reopen
  // descriptor (real cwd, projectId, provider, model, effort) without the
  // presentational leaves having to carry any of it.
  const index = useMemo(() => {
    const map = new Map<
      string,
      { project: V2ProjectWithThreads; thread: V2SavedThread }
    >();
    for (const project of projects) {
      for (const thread of project.threads) {
        map.set(thread.sessionId, { project, thread });
      }
    }
    return map;
  }, [projects]);

  const emptyState: ProjectTreeProps["emptyState"] = error
    ? "error"
    : loaded
      ? "empty"
      : "loading";

  const onActiveState = useCallback(
    (state: Parameters<typeof reportState>[1]) => {
      if (activeThread) reportState(activeThread.key, state);
    },
    [activeThread?.key, reportState],
  );

  const onSelectThread = useCallback(
    (row: ThreadRowProps, projectName: string) => {
      const key = row.id ?? row.title;
      const hit = index.get(key);
      if (!hit) {
        // A row with no backing saved thread (the prop-less placeholder tree in
        // tests/stories). Fall back to the app's own cwd so the well still
        // opens a usable session rather than doing nothing.
        setActiveThread({
          key,
          cwd: config?.cwd ?? "",
          projectName,
          provider: asProviderId(row.provider),
          title: row.title,
        });
        return;
      }
      const { project, thread } = hit;
      setActiveThread({
        key,
        // The thread's OWN cwd wins: a thread keeps the directory it was
        // started in even if the project row was later re-pointed.
        cwd: thread.cwd || project.path,
        projectId: project.id,
        projectName: project.name,
        provider: asProviderId(thread.provider),
        title: thread.title ?? UNTITLED,
        sessionId: thread.sessionId,
        model: thread.model,
        effort: thread.effort,
      });
    },
    [config?.cwd, index],
  );

  // WHA-104 — the breadcrumb's thread menu. It reads the SAME group the sidebar
  // renders for the open project, so the two surfaces cannot disagree on which
  // threads exist or what order they are in, and a pick goes through the same
  // handler a sidebar click does: switching from the crumb and switching from
  // the rail are one code path, including mid-turn (the well is keyed on the
  // selection either way — nothing here can block a running turn).
  //
  // The group is found by WHICH GROUP OWNS THE OPEN ROW, not by
  // `activeThread.projectId`: a draft picked from the rail comes back through
  // the fallback branch above, which has no project id to carry, so an
  // id-keyed lookup silently dropped the switcher exactly when you were in a
  // draft (caught in the browser pass, regression-tested). Matching on the
  // row's own key has no such hole and needs no name matching.
  const crumbGroup = useMemo(
    () =>
      groups.find((group) =>
        group.threads?.some((row) => (row.id ?? row.title) === activeThread?.key),
      ) ?? null,
    [groups, activeThread?.key],
  );

  const crumbThreads = useMemo(
    () =>
      (crumbGroup?.threads ?? []).map((row) => ({
        id: row.id ?? row.title,
        title: row.title,
      })),
    [crumbGroup],
  );

  // Open a thread by its sidebar key, wherever it lives. The breadcrumb only
  // ever looks inside the open project, but the palette searches across all of
  // them, so the lookup is group-agnostic and both callers share one path into
  // `onSelectThread` — the same one a sidebar click takes.
  const selectThreadByKey = useCallback(
    (key: string) => {
      for (const group of groups) {
        const row = group.threads?.find(
          (candidate) => (candidate.id ?? candidate.title) === key,
        );
        if (row) {
          onSelectThread(row, group.name);
          return;
        }
      }
    },
    [groups, onSelectThread],
  );

  // WHA-71/72 — the palette's contents. Same data the rail renders, mapped to
  // the palette's shape; the handlers below are the shell's existing ones, so
  // "New thread in X" from the palette and "New chat" from a project kebab are
  // one code path.
  const paletteProjects = useMemo(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        // 1T4-0 prints the path beside the name on the projects screen.
        path: project.path,
      })),
    [projects],
  );

  /** Recent threads across every project, newest activity first (1T4-0). */
  const paletteThreads = useMemo(
    () =>
      projects
        .flatMap((project) => project.threads)
        .slice()
        .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
        .map((thread) => ({
          id: thread.sessionId,
          title: thread.title ?? UNTITLED,
          preview: thread.lastMessage ?? NO_PREVIEW,
          lastActivity: thread.lastActivity,
        })),
    [projects],
  );

  const paletteActiveProject = useMemo(
    () =>
      crumbGroup?.id
        ? { id: crumbGroup.id, name: crumbGroup.name }
        : null,
    [crumbGroup],
  );

  return (
    <>
      <Layout
        height="fill"
        padding={0}
        start={
          <Sidebar
            groups={groups}
            emptyState={emptyState}
            selectedKey={activeThread?.key ?? null}
            onSelectThread={onSelectThread}
            onAddProject={token ? () => setIsAddingProject(true) : undefined}
            onOpenPalette={openPalette}
          />
        }
        xstyle={styles.shell}
        content={
          <VStack height="100%" gap={0} data-slot="main">
            <Toolbar
              project={activeThread?.projectName ?? "Conan"}
              thread={activeThread?.title ?? "Select a thread"}
              threads={crumbThreads}
              activeThreadId={activeThread?.key ?? null}
              onSelectThread={selectThreadByKey}
              tabs={surfaceTabs}
              onSelect={selectSurface}
              onOpen={openSurface}
              onClose={closeSurface}
              onPlacementChange={changeSurfacePlacement}
            />
            <VStack gap={0} xstyle={styles.well}>
              {/* Keyed by the selection: one useV2Chat per well (docs §9 gotcha
                  2), so switching threads must tear the socket down and open the
                  new thread's session rather than replaying the old one's items
                  under a new descriptor. */}
              <SurfaceWorkspace
                header={<SecondaryBar />}
                activeSurface={activeSurface}
                openSurfaces={openSurfaces}
                placement={
                  activeSurface === "chat" ? undefined : surfacePlacements[activeSurface]
                }
                token={token}
                cwd={activeThread?.cwd ?? config?.cwd ?? null}
                onUndock={undockSurface}
              >
                <V2ChatView
                  key={activeThread?.key ?? "no-thread"}
                  token={token}
                  activeThread={activeThread}
                  onState={activeThread ? onActiveState : undefined}
                />
              </SurfaceWorkspace>
            </VStack>
          </VStack>
        }
      />
      {renameTarget ? (
        <RenameThreadDialog
          isOpen
          currentTitle={renameTarget.title}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          onSave={saveThreadTitle}
        />
      ) : null}
      {deleteTarget ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open && !isDeleting) {
              setDeleteTarget(null);
              setDeleteError(false);
            }
          }}
          title={`Delete “${deleteTarget.title}”?`}
          description={
            deleteError
              ? "The thread could not be deleted. Try again."
              : deleteTarget.status === "working"
                ? "The agent is still working. Deleting this thread stops the current run and removes it from Conan. This action can’t be undone."
                : "This removes the thread from Conan. This action can’t be undone."
          }
          cancelLabel="Cancel"
          actionLabel="Delete thread"
          isActionLoading={isDeleting}
          onAction={() => void confirmDeleteThread()}
        />
      ) : null}
      {removeTarget ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open && !isRemoving) {
              setRemoveTarget(null);
              setRemoveError(false);
            }
          }}
          title={`Remove “${removeTarget.name}”?`}
          // Says both halves on purpose: what goes (the project and its threads,
          // from Conan) and what does not (the folder on disk). A destructive
          // confirmation that only names the deletion invites the worse reading.
          description={
            removeError
              ? "The project could not be removed. Try again."
              : "This removes the project and its threads from Conan. The folder on disk is not deleted. This action can’t be undone."
          }
          cancelLabel="Cancel"
          actionLabel="Remove project"
          isActionLoading={isRemoving}
          onAction={() => void confirmRemoveProject()}
        />
      ) : null}
      {isAddingProject ? (
        <AddProjectDialog
          isOpen
          token={token}
          start={config?.cwd ?? ""}
          onOpenChange={setIsAddingProject}
          onAdd={addProject}
        />
      ) : null}
      <V2CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        projects={paletteProjects}
        threads={paletteThreads}
        activeProject={paletteActiveProject}
        onNewThreadIn={newThreadIn}
        onAddProject={token ? () => setIsAddingProject(true) : undefined}
        onSelectThread={selectThreadByKey}
      />
    </>
  );
}
