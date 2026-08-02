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
import Sidebar from "./Sidebar.tsx";
import Toolbar from "./Toolbar.tsx";
import SecondaryBar from "./components/SecondaryBar.tsx";
import RenameThreadDialog from "./components/RenameThreadDialog.tsx";
import V2ChatView from "./chat/V2ChatView.tsx";
import { useGatewayConfig } from "./lib/useGatewayConfig.ts";
import {
  useV2Projects,
  type V2ProjectWithThreads,
  type V2SavedThread,
} from "./lib/useV2Projects.ts";
import type { ActiveThread, V2Provider } from "./lib/types.ts";
import type { ProjectGroup, ProjectTreeProps } from "./components/ProjectTree.tsx";
import type { ThreadRowProps } from "./components/ThreadRow.tsx";
import { pillOf, useV2ThreadState } from "./lib/useV2ThreadState.ts";
import { writeClipboardText } from "./lib/writeClipboardText.ts";
import { apiBase } from "../lib/gateway.ts";

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
    borderStartStartRadius: "var(--conan-radius-page)",
    flexGrow: 1,
    minHeight: 0,
    overflow: "clip",
  },
});

/** The gateway stores the provider as a free string (null on pre-migration
 *  rows, which it coalesces to claude). Narrow it once, here. */
function asProvider(value: string | null | undefined): V2Provider {
  if (value === "codex" || value === "grok") return value;
  return "claude";
}

/** v1's sidebar copy for a row the DB has no title/preview for yet. */
const UNTITLED = "New chat";
const NO_PREVIEW = "No messages yet";

interface V2Draft {
  id: string;
  projectId: string;
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
  const { states, reportState } = useV2ThreadState();

  const copyText = useCallback((value: string) => {
    void writeClipboardText(value);
  }, []);

  const newThreadIn = useCallback(
    (projectId: string) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      const existing = drafts.find((draft) => draft.projectId === projectId);
      const id = existing?.id ?? `draft-${crypto.randomUUID()}`;
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
              provider: asProvider(thread.provider),
              status: pillOf(states[thread.sessionId]),
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
    [copyText, drafts, newThreadIn, projects, requestDeleteThread, states],
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
          provider: asProvider(row.provider),
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
        provider: asProvider(thread.provider),
        title: thread.title ?? UNTITLED,
        sessionId: thread.sessionId,
        model: thread.model,
        effort: thread.effort,
      });
    },
    [config?.cwd, index],
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
          />
        }
        xstyle={styles.shell}
        content={
          <VStack height="100%" gap={0} data-slot="main">
            <Toolbar
              project={activeThread?.projectName ?? "Conan"}
              thread={activeThread?.title ?? "Select a thread"}
            />
            <VStack gap={0} xstyle={styles.well}>
              <SecondaryBar />
              {/* Keyed by the selection: one useV2Chat per well (docs §9 gotcha
                  2), so switching threads must tear the socket down and open the
                  new thread's session rather than replaying the old one's items
                  under a new descriptor. */}
              <V2ChatView
                key={activeThread?.key ?? "no-thread"}
                token={token}
                activeThread={activeThread}
                onState={activeThread ? onActiveState : undefined}
              />
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
    </>
  );
}
