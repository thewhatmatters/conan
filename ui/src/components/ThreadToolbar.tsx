import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Loader2,
  MessageSquare,
  PanelRight,
  Pencil,
  Play,
  Plus,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { apiBase } from "../lib/gateway.ts";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Thread toolbar (loop/conan-thread-toolbar): a slim h-9 bar pinned above the
 * transcript with the chat title + git context, an editor "Open in", git
 * Commit/Push/Create-PR, and per-project custom actions. Self-contained — it
 * fetches editors / git status / actions itself (and refetches git after a
 * commit/push) against the US-001..004 backend routes.
 */

interface Editor {
  id: string;
  name: string;
  path: string | null;
}
interface DirGit {
  available: boolean;
  branch: string | null;
  dirty: number;
}
type ActionKind = "shell" | "prompt";
interface ProjectAction {
  id: string;
  projectId: string;
  name: string;
  kind: ActionKind;
  command: string;
}
interface RunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
}
/** What the output modal shows — a git result or a custom-action run. */
interface Output {
  title: string;
  ok: boolean;
  text: string;
}

const PREF_EDITOR_KEY = "conan-preferred-editor";

export default function ThreadToolbar({
  token,
  cwd,
  projectId,
  title,
  onSendPrompt,
  surfacesOpen,
  onToggleSurfaces,
}: {
  token: string | null;
  /** The thread's working directory (its project's path). */
  cwd: string | null;
  /** Persisted project id — scopes custom actions. Null for a fresh draft. */
  projectId: string | null;
  /** The thread's title (null → "New chat"). */
  title: string | null;
  /** Send a prompt into this thread's chat (for prompt-kind actions). Returns
   *  false when the thread can't accept it right now (busy / not ready). */
  onSendPrompt: (text: string) => boolean;
  /** Whether this thread's surface panel is open (Conan Surfaces US-001). */
  surfacesOpen: boolean;
  onToggleSurfaces: () => void;
}) {
  const auth = useMemo(
    () => ({ "x-conan-token": token ?? "", "content-type": "application/json" }),
    [token],
  );

  // ── data ──────────────────────────────────────────────────────────────
  const [editors, setEditors] = useState<Editor[]>([]);
  const [git, setGit] = useState<DirGit | null>(null);
  const [actions, setActions] = useState<ProjectAction[]>([]);
  const [prReason, setPrReason] = useState<string | null>(null); // set after a failed PR → disable + explain

  const refreshGit = useCallback(() => {
    if (!token || !cwd) return setGit(null);
    fetch(apiBase() + `/api/fs/git?path=${encodeURIComponent(cwd)}`, {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((g: DirGit | null) => setGit(g))
      .catch(() => {});
  }, [token, cwd]);

  const refreshActions = useCallback(() => {
    if (!token || !projectId) return setActions([]);
    fetch(apiBase() + `/api/agent/projects/${projectId}/actions`, {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : { actions: [] }))
      .then((d: { actions: ProjectAction[] }) => setActions(d.actions ?? []))
      .catch(() => {});
  }, [token, projectId]);

  useEffect(() => {
    if (!token) return;
    fetch(apiBase() + "/api/editor/detect", { headers: { "x-conan-token": token } })
      .then((r) => (r.ok ? r.json() : { editors: [] }))
      .then((d: { editors: Editor[] }) => setEditors(d.editors ?? []))
      .catch(() => {});
  }, [token]);
  useEffect(refreshGit, [refreshGit]);
  useEffect(refreshActions, [refreshActions]);

  // ── dialogs / modal state ─────────────────────────────────────────────
  const [output, setOutput] = useState<Output | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which control is in flight
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null = add, else edit
  const [actName, setActName] = useState("");
  const [actCmd, setActCmd] = useState("");
  const [actKind, setActKind] = useState<ActionKind>("shell");
  const [runningId, setRunningId] = useState<string | null>(null);

  const prefEditor = useRef<string | null>(
    typeof localStorage !== "undefined" ? localStorage.getItem(PREF_EDITOR_KEY) : null,
  );
  const isRepo = git?.available === true;

  // ── handlers ──────────────────────────────────────────────────────────
  const openIn = async (editorId: string) => {
    if (!cwd) return;
    prefEditor.current = editorId;
    try {
      localStorage.setItem(PREF_EDITOR_KEY, editorId);
    } catch {
      /* private mode */
    }
    await fetch(apiBase() + "/api/editor/open", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: cwd, editor: editorId }),
    }).catch(() => {});
  };

  const doCommit = async () => {
    if (!cwd || !commitMsg.trim()) return;
    setBusy("commit");
    try {
      const r = await fetch(apiBase() + "/api/agent/git/commit", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cwd, message: commitMsg.trim() }),
      });
      const d = (await r.json()) as { ok: boolean; output?: string; error?: string };
      setOutput({ title: "Commit", ok: d.ok, text: d.ok ? d.output ?? "" : d.error ?? "failed" });
      if (d.ok) setCommitMsg("");
      setCommitOpen(false);
      refreshGit();
    } finally {
      setBusy(null);
    }
  };

  const doPush = async () => {
    if (!cwd) return;
    setBusy("push");
    try {
      const r = await fetch(apiBase() + "/api/agent/git/push", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cwd }),
      });
      const d = (await r.json()) as { ok: boolean; output?: string; error?: string };
      setOutput({ title: "Push", ok: d.ok, text: d.ok ? d.output ?? "pushed" : d.error ?? "failed" });
      refreshGit();
    } finally {
      setBusy(null);
    }
  };

  const doPr = async () => {
    if (!cwd || !prTitle.trim()) return;
    setBusy("pr");
    try {
      const r = await fetch(apiBase() + "/api/agent/git/pr", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ cwd, title: prTitle.trim(), body: prBody }),
      });
      const d = (await r.json()) as { ok: boolean; url?: string; reason?: string; error?: string };
      if (d.ok) {
        setOutput({ title: "Pull request", ok: true, text: d.url ?? "created" });
      } else {
        // Disable PR + explain for the rest of the session when the env can't do it.
        if (d.reason) setPrReason(d.reason);
        setOutput({ title: "Pull request", ok: false, text: reasonText(d.reason) ?? d.error ?? "failed" });
      }
      setPrOpen(false);
    } finally {
      setBusy(null);
    }
  };

  const openAdd = () => {
    setEditingId(null);
    setActName("");
    setActCmd("");
    setActKind("shell");
    setAddOpen(true);
  };

  const openEdit = (a: ProjectAction) => {
    setEditingId(a.id);
    setActName(a.name);
    setActCmd(a.command);
    setActKind(a.kind);
    setAddOpen(true);
  };

  // Add (POST) or edit (PUT) depending on editingId. Both are project-scoped.
  const submitAction = async () => {
    if (!actName.trim() || !actCmd.trim() || !projectId) return;
    setBusy("add");
    try {
      const base = apiBase() + `/api/agent/projects/${projectId}/actions`;
      await fetch(editingId ? `${base}/${editingId}` : base, {
        method: editingId ? "PUT" : "POST",
        headers: auth,
        body: JSON.stringify({ name: actName.trim(), command: actCmd.trim(), kind: actKind }),
      });
      setActName("");
      setActCmd("");
      setEditingId(null);
      setAddOpen(false);
      refreshActions();
    } finally {
      setBusy(null);
    }
  };

  // Shell actions run in the gateway (output → modal); prompt actions are sent
  // straight into this thread's chat.
  const runAction = async (a: ProjectAction) => {
    if (a.kind === "prompt") {
      if (!onSendPrompt(a.command)) {
        setOutput({
          title: a.name,
          ok: false,
          text: "Can't send right now — the chat is busy or still loading. Try again in a moment.",
        });
      }
      return;
    }
    if (!projectId) return;
    setRunningId(a.id);
    try {
      const r = await fetch(
        apiBase() + `/api/agent/projects/${projectId}/actions/${a.id}/run`,
        { method: "POST", headers: auth, body: "{}" },
      );
      const d = (await r.json()) as RunResult;
      const body = [d.stdout, d.stderr && `[stderr]\n${d.stderr}`, d.error]
        .filter(Boolean)
        .join("\n")
        .trim();
      setOutput({
        title: a.name,
        ok: d.ok && (d.exitCode ?? 0) === 0,
        text: body || `exit ${d.exitCode ?? "?"}${d.timedOut ? " (timed out)" : ""}`,
      });
    } finally {
      setRunningId(null);
    }
  };

  const deleteAction = async (id: string) => {
    if (!projectId) return;
    await fetch(apiBase() + `/api/agent/projects/${projectId}/actions/${id}`, {
      method: "DELETE",
      headers: { "x-conan-token": token ?? "" },
    }).catch(() => {});
    refreshActions();
  };

  const prDisabled = prReason != null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3 text-xs">
      {/* Left: the chat title (branch lives in the composer context row). */}
      <span className="min-w-0 truncate font-medium text-foreground" title={title ?? "New chat"}>
        {title ?? "New chat"}
      </span>

      <div className="ml-auto flex items-center gap-1">
        {/* Custom actions */}
        {actions.map((a) => (
          <span key={a.id} className="group/act inline-flex items-center">
            <button
              type="button"
              onClick={() => void runAction(a)}
              disabled={runningId === a.id}
              title={`${a.kind === "prompt" ? "Send to chat" : "Run"}: ${a.command}`}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {runningId === a.id ? (
                <Loader2 className="size-3 animate-spin" />
              ) : a.kind === "prompt" ? (
                <MessageSquare className="size-3" />
              ) : (
                <Play className="size-3" />
              )}
              <span className="max-w-24 truncate">{a.name}</span>
            </button>
            <button
              type="button"
              onClick={() => openEdit(a)}
              aria-label={`Edit ${a.name}`}
              title="Edit action"
              className="ml-0.5 hidden cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground group-hover/act:inline-flex"
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => void deleteAction(a.id)}
              aria-label={`Delete ${a.name}`}
              title="Delete action"
              className="hidden cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive group-hover/act:inline-flex"
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={openAdd}
          disabled={!projectId}
          title={projectId ? "Add a custom action" : "Send a message first to create the project"}
          aria-label="Add action"
          className="inline-flex cursor-pointer items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-3.5" />
        </button>

        <span className="mx-0.5 h-4 w-px bg-border" />

        {/* Open in editor */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={!cwd}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none disabled:opacity-40"
          >
            <FolderOpen className="size-3.5" />
            Open
            <ChevronDown className="size-3 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editors.length === 0 && (
              <DropdownMenuItem disabled>No editors detected</DropdownMenuItem>
            )}
            {editors.map((e) => (
              <DropdownMenuItem key={e.id} onClick={() => void openIn(e.id)}>
                {e.id === "finder" ? (
                  <FolderOpen className="size-3.5 text-muted-foreground" />
                ) : (
                  <Terminal className="size-3.5 text-muted-foreground" />
                )}
                {e.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Git actions — only meaningful in a repo */}
        {isRepo && (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none">
              <GitCommitHorizontal className="size-3.5" />
              Git
              <ChevronDown className="size-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setCommitOpen(true)}
                disabled={git?.dirty === 0}
              >
                <GitCommitHorizontal className="size-3.5 text-muted-foreground" />
                Commit{git?.dirty ? ` (${git.dirty})` : " — nothing to commit"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void doPush()} disabled={busy === "push"}>
                <Upload className="size-3.5 text-muted-foreground" />
                Push
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setPrOpen(true)}
                disabled={prDisabled}
                title={prDisabled ? reasonText(prReason) ?? "" : ""}
              >
                <GitPullRequestArrow className="size-3.5 text-muted-foreground" />
                Create PR{prDisabled ? " — unavailable" : ""}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <span className="mx-0.5 h-4 w-px bg-border" />

        {/* Surface panel toggle (Conan Surfaces US-001) */}
        <button
          type="button"
          onClick={onToggleSurfaces}
          title={surfacesOpen ? "Close the surface panel" : "Open a surface (Browser · Terminal · Files · Diff)"}
          aria-pressed={surfacesOpen}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted hover:text-foreground",
            surfacesOpen ? "bg-muted text-foreground" : "text-muted-foreground",
          )}
        >
          <PanelRight className="size-3.5" />
          Surfaces
        </button>
      </div>

      {/* ── Commit dialog ── */}
      <Dialog open={commitOpen} onOpenChange={setCommitOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Commit changes</DialogTitle>
            <DialogDescription>
              Stages all changes (`git add -A`) in {cwd?.split("/").pop()} and commits.
            </DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            rows={3}
            placeholder="Commit message"
            className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus-visible:border-primary/60"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCommitOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void doCommit()} disabled={!commitMsg.trim() || busy === "commit"}>
              {busy === "commit" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Commit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── PR dialog ── */}
      <Dialog open={prOpen} onOpenChange={setPrOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create pull request</DialogTitle>
            <DialogDescription>Opens a PR via `gh` for the current branch.</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="PR title"
            className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus-visible:border-primary/60"
          />
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={4}
            placeholder="Description (optional)"
            className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus-visible:border-primary/60"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPrOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void doPr()} disabled={!prTitle.trim() || busy === "pr"}>
              {busy === "pr" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Create PR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add-action dialog ── */}
      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setEditingId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit action" : "Add a custom action"}</DialogTitle>
            <DialogDescription>
              A named toolbar button, saved to{" "}
              <code>.conan/actions.md</code> in this project (git-shareable).
            </DialogDescription>
          </DialogHeader>

          {/* Kind toggle — shell command vs chat prompt. */}
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-1">
            {(
              [
                { k: "shell", Icon: Terminal, label: "Shell command", hint: "Runs in a shell" },
                { k: "prompt", Icon: MessageSquare, label: "Chat prompt", hint: "Sent to the agent" },
              ] as const
            ).map(({ k, Icon, label, hint }) => (
              <button
                key={k}
                type="button"
                onClick={() => setActKind(k)}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-0.5 rounded px-2 py-1.5 text-center transition-colors",
                  actKind === k
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <Icon className="size-3.5" />
                  {label}
                </span>
                <span
                  className={cn(
                    "text-[10px]",
                    actKind === k ? "text-primary-foreground/80" : "text-muted-foreground/70",
                  )}
                >
                  {hint}
                </span>
              </button>
            ))}
          </div>

          <input
            autoFocus
            value={actName}
            onChange={(e) => setActName(e.target.value)}
            placeholder={actKind === "prompt" ? "Name (e.g. Design pass)" : "Name (e.g. Typecheck)"}
            className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus-visible:border-primary/60"
          />
          {actKind === "prompt" ? (
            <textarea
              value={actCmd}
              onChange={(e) => setActCmd(e.target.value)}
              rows={3}
              placeholder="Prompt (e.g. Run the /codebase-design skill on this repo)"
              className="w-full resize-none rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus-visible:border-primary/60"
            />
          ) : (
            <input
              value={actCmd}
              onChange={(e) => setActCmd(e.target.value)}
              placeholder="Command (e.g. npm run typecheck) — no prefix, e.g. pwd not ! pwd"
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground outline-none focus-visible:border-primary/60"
            />
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submitAction()}
              disabled={!actName.trim() || !actCmd.trim() || busy === "add"}
            >
              {editingId ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Output modal (git results + action runs) ── */}
      <Dialog open={output != null} onOpenChange={(o) => !o && setOutput(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", output?.ok ? "bg-chart-2" : "bg-destructive")} />
              {output?.title}
            </DialogTitle>
          </DialogHeader>
          {output?.title === "Pull request" && output.ok ? (
            <a
              href={output.text}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-sm text-primary underline underline-offset-2"
            >
              {output.text}
            </a>
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
              {output?.text}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Human text for the backend's PR-degrade reasons. */
function reasonText(reason: string | null | undefined): string | null {
  switch (reason) {
    case "gh-missing":
      return "GitHub CLI (`gh`) is not installed.";
    case "gh-unauthed":
      return "GitHub CLI is not authenticated — run `gh auth login`.";
    case "not-github":
      return "This repo's origin remote is not GitHub.";
    default:
      return null;
  }
}
