import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ClipboardList,
  FilePenLine,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  History,
  Loader2,
  Lock,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  SquareSlash,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useAgentChat,
  type AgentOpts,
  type ApprovalResolution,
  type ChatItem,
  type PendingApproval,
  type PermissionDecision,
  type ToolPermissionKind,
} from "../hooks/useAgentChat.ts";
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
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { cn } from "../lib/utils.ts";
import { apiBase } from "../lib/gateway.ts";
import { basename } from "./DirBrowser.tsx";
import { useDirGit } from "../hooks/useDirGit.ts";
import type { SkillFiredEvent } from "../hooks/useTasks.ts";
import type { SkillEntry } from "../hooks/useSkills.ts";
import { useProviders, type ProviderStatus } from "../hooks/useProviders.ts";
import ActivitySpine, { type SpineTurn } from "./ActivitySpine.tsx";
import ThreadToolbar from "./ThreadToolbar.tsx";
import { buildFileDiff, type FileDiff } from "../lib/diff.ts";

/** One slash command from GET /api/claude/commands (src/commands/index.ts). */
interface CommandEntry {
  name: string;
  description: string | null;
  source: "user" | "project" | "built-in";
  argumentHint?: string;
}
import {
  AutocompleteOverlay,
  useComposerAutocomplete,
  type AutocompleteSource,
} from "./ComposerAutocomplete.tsx";

/**
 * Level-2 chat spike — the programmatic peer of the terminal surface.
 *
 * A custom transcript (rendered from the gateway's normalized agent events) +
 * a composer whose chips map to real `claude -p` flags. This is the t3-code
 * interaction model inside Conan's existing Tauri shell: no TUI, no xterm —
 * Conan drives `claude` headlessly and owns the rendering.
 *
 * Multi-provider (T3-1 US-008): the composer's provider chip picks which
 * agent CLI drives a FRESH thread (claude/codex/grok, from the registry's
 * install probe); it locks with the rest of the launch config after the first
 * turn, and a reopened thread shows its saved provider locked from the start.
 */

/** `--model` chip options — aliases resolve to the latest of each family. */
const MODELS: { label: string; value: string | undefined }[] = [
  { label: "Default model", value: undefined },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

/** `--permission-mode` chip options. Supervised (`default`) is the default —
 *  the driver's control-channel approval round-trip (US-004) answers the tool
 *  prompts interactively, so a terminal-less surface never needs to blanket-
 *  bypass. Full access runs every tool unprompted and gets a one-time confirm. */
const PERMISSIONS: {
  label: string;
  value: NonNullable<AgentOpts["permissionMode"]>;
  icon: LucideIcon;
  hint: string;
}[] = [
  { label: "Plan", value: "plan", icon: ClipboardList, hint: "Read-only — ends with a proposed plan" },
  { label: "Supervised", value: "default", icon: ShieldCheck, hint: "Asks before running tools" },
  { label: "Accept edits", value: "acceptEdits", icon: FilePenLine, hint: "Auto-approves file edits" },
  { label: "Full access", value: "bypassPermissions", icon: ShieldAlert, hint: "Runs every tool without prompting" },
];

/** Render-facing thread state, reported up to the sidebar (US-006) so the
 *  thread list can show status pills for hidden threads. */
export interface ThreadUiState {
  status: "connecting" | "open" | "closed";
  busy: boolean;
  awaitingApproval: boolean;
  /** First user prompt (sidebar label). Null until the first turn is sent. */
  title: string | null;
  /** The real Claude session id (system init event) — the shell binds
   *  session-scoped concerns (native notifications) to the ACTIVE thread's
   *  session now that no pty correlation exists (US-012). */
  sessionId: string | null;
}

/** Reopened-thread context (US-015): the saved session to reconstruct and
 *  continue. `model` is the saved launch model, re-applied on resume so the
 *  continued conversation stays on the model it started with. */
export interface ResumeTarget {
  sessionId: string;
  model: string | null;
  /** The provider that created the thread (US-008) — shown locked in the
   *  chip; the gateway resumes on it regardless. Null → claude (pre-
   *  migration rows). */
  provider: string | null;
}

/** One reconstructed history entry from GET /api/agent/threads/:id/transcript
 *  (mirrors the gateway's HistoryItem). */
type HistoryItem =
  | { role: "user" | "assistant" | "reasoning"; text: string }
  | { role: "tool"; id: string; name: string; input: unknown; result: string | null; isError: boolean };

export default function ChatPane({
  token,
  cwd,
  projectId,
  resume,
  lastSkillFired,
  onState,
}: {
  token: string | null;
  /** The thread's working directory — its PROJECT's path (US-025: the project
   *  owns the path; threads never diverge from it). Sent with every prompt
   *  frame — the gateway pins the first one (US-001). */
  cwd?: string | null;
  /** Persisted project id (US-014) — rides the prompt frame so the gateway
   *  can upsert this thread's chat_thread row at session init. */
  projectId?: string | null;
  /** Saved session to reopen (US-015): its transcript is reconstructed above
   *  the live items and the first prompt launches with `--resume`. */
  resume?: ResumeTarget | null;
  /** Latest `{type:'skill-fired'}` app-WS broadcast (US-017) — each pane
   *  filters by its OWN session id, so a firing lands on the right spine even
   *  with several threads mounted. */
  lastSkillFired?: SkillFiredEvent | null;
  onState?: (s: ThreadUiState) => void;
}) {
  const {
    items,
    busy,
    status,
    sessionId,
    pendingApproval,
    pendingApprovals,
    respondToApproval,
    send,
    interrupt,
    permissionMode: liveMode,
    setPermissionMode,
  } = useAgentChat(token);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(undefined);
  // Provider chip selection (US-008) — which agent CLI a FRESH thread
  // launches on. A reopened thread ignores this: its saved provider wins.
  const [provider, setProvider] = useState<string>("claude");
  const [permission, setPermission] =
    useState<NonNullable<AgentOpts["permissionMode"]>>("default");
  // Full-access one-time confirm: selecting bypassPermissions opens the dialog
  // until it has been accepted once in this thread; declining reverts.
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const fullAccessConfirmed = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the view is pinned to the bottom. Scrolling up releases the pin
  // (so streaming doesn't yank the user back down); scrolling back near the
  // bottom re-engages it.
  const pinnedRef = useRef(true);

  // Reopened thread (US-015): reconstruct the saved transcript once. "missing"
  // (JSONL gone) degrades to metadata-only — the next prompt starts a FRESH
  // session instead of passing --resume, so a new turn still works.
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [historyState, setHistoryState] = useState<
    "loading" | "found" | "missing" | null
  >(resume ? "loading" : null);
  useEffect(() => {
    if (!resume || !token) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          apiBase() +
            `/api/agent/threads/${encodeURIComponent(resume.sessionId)}/transcript`,
          { headers: { "x-conan-token": token } },
        );
        const data = (await r.json()) as { found: boolean; items: HistoryItem[] };
        if (cancelled) return;
        if (!r.ok || !data.found) {
          setHistoryState("missing");
          return;
        }
        setHistory(
          data.items.map((it, i) =>
            it.role === "tool"
              ? { ...it, id: `h${i}-${it.id}` }
              : { id: `h${i}`, role: it.role, text: it.text },
          ),
        );
        setHistoryState("found");
      } catch {
        if (!cancelled) setHistoryState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume?.sessionId, token]);

  // Report thread state up to the sidebar. The parent's setter bails when
  // nothing changed, so an unstable onState identity can't loop renders.
  const firstUser = items.find((it) => it.role === "user");
  // Title: the first user prompt — from the live items, or the restored history
  // for a resumed thread (otherwise the toolbar/sidebar read "New chat" on
  // reopen). Capped at 256 so a pasted wall of text can't blow out the bar.
  const titleSource = firstUser ?? history.find((it) => it.role === "user");
  const title =
    titleSource && titleSource.role === "user" ? titleSource.text.slice(0, 256) : null;
  useEffect(() => {
    onState?.({
      status,
      busy,
      awaitingApproval: pendingApproval != null,
      title,
      sessionId,
    });
  }, [status, busy, pendingApproval, title, sessionId, onState]);

  // Stick to the bottom as the transcript grows — unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items, history, busy]);

  const effectiveCwd = cwd ?? null;
  // Branch/dirty for THIS thread's directory — per-thread, so a hidden thread
  // on another repo never shows the active thread's branch.
  const git = useDirGit(token, effectiveCwd);

  // `@` files/folders autocomplete (US-018) — bounded recursive search under
  // THIS thread's cwd. The inserted `@path` is a reference only; the agent
  // reads the file itself (no content pinning).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileSource = useMemo<AutocompleteSource>(
    () => ({
      trigger: "@",
      empty: "No matching files",
      fetch: async (q) => {
        if (!token || !effectiveCwd) return [];
        const r = await fetch(
          apiBase() +
            `/api/fs/search?path=${encodeURIComponent(effectiveCwd)}&q=${encodeURIComponent(q)}`,
          { headers: { "x-conan-token": token } },
        );
        if (!r.ok) return [];
        const data = (await r.json()) as {
          hits: { rel: string; name: string; isDir: boolean }[];
        };
        return data.hits.map((h) => ({
          insert: `@${h.rel}${h.isDir ? "/" : ""}`,
          label: `${h.rel}${h.isDir ? "/" : ""}`,
          icon: h.isDir ? Folder : FileText,
        }));
      },
    }),
    [token, effectiveCwd],
  );
  // `$` installed-skills autocomplete (US-019) — user+project+plugin skills
  // from GET /api/claude/skills, fetched lazily on the first `$` and cached
  // for the pane's lifetime (SKILL.md frontmatter is static for a session).
  const skillsRef = useRef<SkillEntry[] | null>(null);
  const skillSource = useMemo<AutocompleteSource>(
    () => ({
      trigger: "$",
      empty: "No matching skills",
      fetch: async (q) => {
        if (!token) return [];
        if (!skillsRef.current) {
          const r = await fetch(apiBase() + "/api/claude/skills", {
            headers: { "x-conan-token": token },
          });
          if (!r.ok) return [];
          skillsRef.current = (await r.json()) as SkillEntry[];
        }
        const query = q.toLowerCase();
        return skillsRef.current
          .map((s) => {
            const name = s.name.toLowerCase();
            const rank = name.startsWith(query)
              ? 0
              : name.includes(query)
                ? 1
                : (s.description ?? "").toLowerCase().includes(query)
                  ? 2
                  : -1;
            return { s, rank };
          })
          .filter((x) => x.rank >= 0)
          .sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name))
          .slice(0, 25)
          .map(({ s }) => ({
            insert: `$${s.name}`,
            label: s.name,
            hint: s.description ?? s.source,
            icon: Sparkles,
          }));
      },
    }),
    [token],
  );
  // `/` slash-commands autocomplete (US-020) — custom command files (user +
  // project, scoped to THIS thread's cwd) plus the gateway's empirically
  // verified headless-safe built-in subset (most built-ins are TUI-only and
  // never offered — see src/commands/index.ts). Fetched lazily on the first
  // `/` and cached for the pane's lifetime, like skills.
  const commandsRef = useRef<CommandEntry[] | null>(null);
  const commandSource = useMemo<AutocompleteSource>(
    () => ({
      trigger: "/",
      empty: "No matching commands",
      fetch: async (q) => {
        if (!token) return [];
        if (!commandsRef.current) {
          const url = effectiveCwd
            ? `/api/claude/commands?cwd=${encodeURIComponent(effectiveCwd)}`
            : "/api/claude/commands";
          const r = await fetch(apiBase() + url, {
            headers: { "x-conan-token": token },
          });
          if (!r.ok) return [];
          commandsRef.current = (await r.json()) as CommandEntry[];
        }
        const query = q.toLowerCase();
        return commandsRef.current
          .map((c) => {
            const name = c.name.toLowerCase();
            const rank = name.startsWith(query)
              ? 0
              : name.includes(query)
                ? 1
                : (c.description ?? "").toLowerCase().includes(query)
                  ? 2
                  : -1;
            return { c, rank };
          })
          .filter((x) => x.rank >= 0)
          .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
          .slice(0, 25)
          .map(({ c }) => ({
            insert: `/${c.name}`,
            label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`,
            // The source label matters here: a project command and a built-in
            // can look alike, but only one is this repo's own workflow.
            hint: c.description ? `${c.source} · ${c.description}` : c.source,
            icon: SquareSlash,
          }));
      },
    }),
    [token, effectiveCwd],
  );
  const ac = useComposerAutocomplete(
    [fileSource, skillSource, commandSource],
    setText,
    textareaRef,
  );

  // The launch config is fixed at the first prompt (one model/cwd per
  // process) — the model chip + directory pill lock once a turn is sent, and
  // a reopened thread is locked from the start: its config came from the
  // saved session it resumes. The PERMISSION chip is the exception: the
  // control channel can switch mode mid-session (US-022), so it stays live.
  const locked = firstUser != null || resume != null;

  // Provider chip data (US-008): the registry's install probe, shared across
  // panes. Until the fetch lands (or if the gateway is unreachable) the chip
  // falls back to a Claude-only entry so it's never blank.
  const providerList = useProviders(token);
  const effectiveProviderId = resume ? resume.provider ?? "claude" : provider;
  const providerMeta: Pick<ProviderStatus, "id" | "name" | "avatarLetter"> =
    providerList.find((p) => p.id === effectiveProviderId) ??
    (effectiveProviderId === "claude"
      ? { id: "claude", name: "Claude Code", avatarLetter: "C" }
      : {
          id: effectiveProviderId,
          name: effectiveProviderId.charAt(0).toUpperCase() + effectiveProviderId.slice(1),
          avatarLetter: effectiveProviderId.charAt(0).toUpperCase(),
        });
  const selectProvider = (id: string) => {
    setProvider(id);
    // The model chip's aliases (opus/sonnet/haiku) are Claude vocabulary — a
    // non-Claude provider launches on its own default model.
    if (id !== "claude") setModel(undefined);
  };
  // Non-Claude providers only offer "Default model" — never a Claude alias.
  const modelOptions = effectiveProviderId === "claude" ? MODELS : [MODELS[0]!];

  // Send an arbitrary prompt through the same launch config as the composer.
  // Returns false when a send can't happen (busy / not open / history loading)
  // so the caller can decide whether to clear its input. Used by the composer
  // submit and by prompt-kind toolbar actions.
  const sendPrompt = (promptText: string): boolean => {
    const t = promptText.trim();
    if (!t || busy || status !== "open" || historyState === "loading") return false;
    send(t, {
      model: resume ? resume.model ?? undefined : model,
      permissionMode: permission,
      cwd: effectiveCwd ?? undefined,
      projectId: projectId ?? undefined,
      resume: resume && historyState === "found" ? resume.sessionId : undefined,
      // US-008: fresh threads launch on the chip's pick; a resumed thread
      // relaunches its own provider (also honored when the JSONL is missing
      // and the "resume" degrades to a fresh session on the same agent).
      provider: effectiveProviderId,
    });
    return true;
  };

  const submit = () => {
    if (sendPrompt(text)) setText("");
  };

  const selectPermission = (value: NonNullable<AgentOpts["permissionMode"]>) => {
    if (value === "bypassPermissions" && !fullAccessConfirmed.current) {
      setConfirmingFullAccess(true);
      return;
    }
    applyPermission(value);
  };

  // Pre-launch the chip sets the local launch config; once the session exists
  // the switch rides the control channel (the US-022 path). No optimistic
  // update on the live path — the chip follows the confirmed `permissionMode`
  // event, and a failed switch (error item) leaves it on the prior mode.
  const applyPermission = (value: NonNullable<AgentOpts["permissionMode"]>) => {
    if (sessionId != null) setPermissionMode(value);
    else setPermission(value);
  };

  const modelLabel = resume
    ? resume.model ?? "Default model"
    : MODELS.find((m) => m.value === model)?.label ?? "Default model";
  // The indicator follows the LIVE mode once the session reports one — a
  // mid-session switch (the plan card's "Proceed in build", US-022) moves the
  // locked chip off Plan so it never lies about what the agent may do.
  const effectiveMode = liveMode ?? permission;
  const perm = PERMISSIONS.find((p) => p.value === effectiveMode) ?? PERMISSIONS[1]!;

  // Plan-card context (US-022): lets a plan card answer the approval gating
  // it (proceed = build continues THIS turn) or, once settled, switch the
  // session off plan for the next turn.
  const planCtx: PlanCtx = {
    approvalFor: (toolUseId) => pendingApprovals.find((p) => p.toolUseId === toolUseId),
    respond: respondToApproval,
    proceed: () => setPermissionMode("default"),
    inPlanMode: effectiveMode === "plan",
    busy,
  };

  // Activity-spine turns (US-016/US-017): one group per user prompt across
  // the restored history + the live transcript, with the tools that ran
  // during each turn clustered beneath it. The Skill tool_use card itself is
  // skipped — the accent skill tick (from the WS broadcast below) covers it,
  // and a faint duplicate underneath would double-count the firing.
  const turnGroups: SpineTurn[] = [];
  for (const it of [...history, ...items]) {
    if (it.role === "user") {
      turnGroups.push({ id: it.id, text: it.text, ticks: [] });
    } else if (it.role === "tool" && it.name !== "Skill") {
      const group = turnGroups[turnGroups.length - 1];
      if (group) {
        const summary = toolSummary(it.input);
        group.ticks.push({
          kind: "tool",
          label: summary ? `${it.name} · ${summary}` : it.name,
        });
      }
    }
  }

  // Skills fired in THIS session (US-017), from the app-WS broadcast. Each
  // firing is pinned to the turn that was current when it arrived (the JSONL
  // reconstruct carries no skill rows, so these only accrue live).
  const [firedSkills, setFiredSkills] = useState<
    { turnIndex: number; skill: string; ts: number }[]
  >([]);
  const turnCountRef = useRef(0);
  turnCountRef.current = turnGroups.length;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  useEffect(() => {
    if (!lastSkillFired) return;
    const sid = sessionIdRef.current;
    if (!sid || lastSkillFired.sessionId !== sid) return;
    const { skill, ts } = lastSkillFired.payload;
    const turnIndex = turnCountRef.current - 1;
    if (turnIndex < 0) return;
    setFiredSkills((prev) =>
      prev.some((f) => f.skill === skill && f.ts === ts)
        ? prev
        : [...prev, { turnIndex, skill, ts }],
    );
  }, [lastSkillFired]);

  // Merge: skill ticks lead their turn's cluster (accent before faint).
  const turns: SpineTurn[] = turnGroups.map((g, i) => {
    const skills = firedSkills.filter((f) => f.turnIndex === i);
    return skills.length === 0
      ? g
      : {
          ...g,
          ticks: [
            ...skills.map((f) => ({ kind: "skill" as const, label: f.skill })),
            ...g.ticks,
          ],
        };
  });
  const jumpToTurn = (id: string) => {
    // Scoped to THIS pane's scroller — item ids repeat across the
    // mounted-but-hidden threads, so a global lookup could hit another pane.
    scrollRef.current
      ?.querySelector(`[data-turn="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <ThreadToolbar
        token={token}
        cwd={effectiveCwd}
        projectId={projectId ?? null}
        title={title}
        onSendPrompt={sendPrompt}
      />
      <div className="flex min-h-0 flex-1">
      {/* Transcript — aside-rooted so it inherits the themed 6px scrollbar. */}
      <aside
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {historyState === "loading" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Restoring conversation…
            </div>
          )}
          {historyState === "missing" && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              This chat's saved history couldn't be found on disk — your next
              message starts a fresh session in this project.
            </div>
          )}
          {history.map((it) => (
            <Anchored key={it.id} item={it} planCtx={planCtx} />
          ))}
          {historyState === "found" && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <History className="size-3 shrink-0" />
              <span>
                {items.length === 0
                  ? "Restored from history — your next message resumes this conversation."
                  : "Resumed from history"}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          {items.length === 0 && historyState === null ? (
            <EmptyState status={status} />
          ) : (
            items.map((it) => <Anchored key={it.id} item={it} planCtx={planCtx} />)
          )}
          {busy && <WorkingIndicator items={items} />}
        </div>
      </aside>
      {/* Activity spine (US-016) — outside the scroller so it stays put
          while the transcript scrolls; bound to this thread's turns. */}
      <ActivitySpine turns={turns} onJump={jumpToTurn} />
      </div>

      {/* Composer — textarea with a chip row + send button. */}
      <div className="shrink-0 px-4 pb-4">
        {/* Thread context pills — ABOVE the input (the Claude Code pattern),
            scoped to THIS thread. cwd and branch describe the conversation,
            not the app, so they live with the composer instead of in a
            full-width app footer. Left = the working directory (interactive
            picker); then the branch it's on (informational). */}
        <div className="mx-auto mb-1.5 flex w-full max-w-3xl items-center gap-1.5">
          {/* Static directory pill (US-025): the PROJECT owns the path, so
              this is an indicator, not a picker. Lock appears once the first
              turn fixes the session's launch cwd, as before. */}
          <span
            title={
              (effectiveCwd ? `${effectiveCwd}\n` : "") +
              (locked
                ? "Locked for this session — the project owns the path"
                : "Project directory")
            }
            className="flex min-w-0 cursor-default items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
          >
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="max-w-40 truncate">
              {effectiveCwd ? basename(effectiveCwd) : "Directory"}
            </span>
            {locked && <Lock className="size-3 shrink-0 opacity-60" />}
          </span>
          {git?.available && git.branch && (
            <span
              title={`${git.branch}${git.dirty ? ` · ${git.dirty} uncommitted` : ""}`}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
            >
              <GitBranch className="size-3.5 shrink-0" />
              <span className="max-w-48 truncate">
                {git.branch}
                {git.dirty ? "*" : ""}
              </span>
            </span>
          )}
          <div className="flex-1" />
          {status !== "open" && (
            <span
              className={cn(
                "text-[11px]",
                status === "connecting" ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {status === "connecting" ? "connecting to agent…" : "agent disconnected"}
            </span>
          )}
        </div>
        <div className="relative mx-auto w-full max-w-3xl rounded-xl border border-border bg-card p-3 shadow-sm focus-within:border-primary/60">
          {!pendingApproval && <AutocompleteOverlay ac={ac} />}
          {pendingApproval ? (
            /* Supervised mode: the input area becomes the approval prompt —
               the turn is blocked on this decision, so typing can wait. */
            <ApprovalPanel
              approval={pendingApproval}
              count={pendingApprovals.length}
              respond={respondToApproval}
            />
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  ac.sync();
                }}
                onSelect={ac.sync}
                onBlur={ac.dismiss}
                onKeyDown={(e) => {
                  // The autocomplete overlay gets first refusal on keys
                  // (↑/↓/Enter/Tab/Esc while open).
                  if (ac.onKeyDown(e)) {
                    e.preventDefault();
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                disabled={status === "closed"}
                placeholder={
                  status === "closed"
                    ? "Agent disconnected — start a new chat to continue"
                    : "Message the agent…  (Enter to send, Shift+Enter for newline)"
                }
                className="max-h-48 min-h-9 w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="mt-2 flex items-center gap-2">
                {/* Provider chip (US-008): which agent CLI drives this thread.
                    Locks with the launch config; uninstalled providers stay
                    listed but disabled so the option is discoverable. */}
                <Chip
                  icon={<ProviderLetter letter={providerMeta.avatarLetter} />}
                  label={providerMeta.name}
                  locked={locked}
                >
                  {(providerList.length
                    ? providerList
                    : [{ id: "claude", name: "Claude Code", avatarLetter: "C", installed: true, version: null }]
                  ).map((p) => (
                    <div key={p.id} title={p.installed ? undefined : `${p.id} not found on PATH`}>
                      <DropdownMenuItem
                        disabled={!p.installed}
                        onClick={() => selectProvider(p.id)}
                      >
                        <ProviderLetter letter={p.avatarLetter} />
                        <div className="flex flex-col">
                          <span>{p.name}</span>
                          {!p.installed && (
                            <span className="text-[11px] text-muted-foreground">
                              {p.id} not found on PATH
                            </span>
                          )}
                        </div>
                      </DropdownMenuItem>
                    </div>
                  ))}
                </Chip>
                <span className="text-border">|</span>
                <Chip icon={<Sparkles className="size-3.5" />} label={modelLabel} locked={locked}>
                  {modelOptions.map((m) => (
                    <DropdownMenuItem key={m.label} onClick={() => setModel(m.value)}>
                      {m.label}
                    </DropdownMenuItem>
                  ))}
                </Chip>
                <span className="text-border">|</span>
                {/* The active permission mode stays visible here whether or not the
                    dropdown is ever opened — the persistent indicator. */}
                <Chip
                  icon={<perm.icon className="size-3.5" />}
                  label={perm.label}
                  className={cn(
                    perm.value === "bypassPermissions" && "text-destructive hover:text-destructive",
                  )}
                >
                  {PERMISSIONS.map((p) => (
                    <DropdownMenuItem key={p.value} onClick={() => selectPermission(p.value)}>
                      <p.icon className="size-3.5 text-muted-foreground" />
                      <div className="flex flex-col">
                        <span>{p.label}</span>
                        <span className="text-[11px] text-muted-foreground">{p.hint}</span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </Chip>
                <div className="flex-1" />
                {busy ? (
                  <button
                    onClick={interrupt}
                    aria-label="Stop"
                    title="Stop — cancel this turn (the conversation survives)"
                    className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Square className="size-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={!text.trim() || status !== "open" || historyState === "loading"}
                    aria-label="Send"
                    className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-40"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* One-time Full-access confirm — declining (or dismissing) reverts to
          the previously selected mode; confirming skips the dialog next time. */}
      <Dialog open={confirmingFullAccess} onOpenChange={(open) => !open && setConfirmingFullAccess(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-destructive" />
              Switch to Full access?
            </DialogTitle>
            <DialogDescription>
              Full access runs <strong>every</strong> tool the agent asks for —
              shell commands, file edits, network access — without asking you
              first. There is no approval step and no terminal to catch it.
              Only use it in a directory you trust the agent to change freely.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmingFullAccess(false)}>
              Keep {perm.label}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                fullAccessConfirmed.current = true;
                applyPermission("bypassPermissions");
                setConfirmingFullAccess(false);
              }}
            >
              Enable Full access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Live turn indicator. A bare "Working…" reads as a hang on long turns (a
 * verification-heavy prompt can legitimately run for minutes), so this shows
 * elapsed time plus what the agent is doing right now — the last tool it
 * reached for. Dogfooding finding: the transcript looked frozen mid-turn.
 */
function WorkingIndicator({ items }: { items: ChatItem[] }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  // The most recent tool card still awaiting its result = current activity.
  let activity: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.role === "tool") {
      if (it.result == null) activity = it.name;
      break;
    }
  }

  const label =
    elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, "0")}s`
      : `${elapsed}s`;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      <span>Working…</span>
      {activity && (
        <>
          <span className="text-border">·</span>
          <span className="font-medium text-foreground/70">{activity}</span>
        </>
      )}
      <span className="text-border">·</span>
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

/** Tiny round agent-avatar letter (C/X/G) — the provider chip's icon, sized
 *  to sit where the other chips put a lucide glyph. */
function ProviderLetter({ letter }: { letter: string }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-foreground ring-1 ring-border">
      {letter}
    </span>
  );
}

/** A composer chip: an icon + label that opens a dropdown of options. Locked
 *  chips (launch config fixed after the first turn) render as a static
 *  indicator — still visible, no longer changeable. */
function Chip({
  icon,
  label,
  locked,
  className,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  locked?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (locked) {
    return (
      <span
        title="Locked for this thread — a new chat starts a fresh config"
        className={cn(
          "flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground",
          className,
        )}
      >
        {icon}
        {label}
        <Lock className="size-3 opacity-60" />
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {icon}
        {label}
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ status }: { status: string }) {
  return (
    <div className="mt-16 flex flex-col items-center gap-2 text-center text-muted-foreground">
      <Sparkles className="size-6 opacity-50" />
      <p className="text-sm font-medium text-foreground">Chat with a coding agent</p>
      <p className="max-w-sm text-xs">
        Drives <code className="rounded bg-muted px-1 py-px font-mono text-[11px]">claude</code>{" "}
        headlessly in the active directory and renders the conversation here —
        no terminal required.{" "}
        {status === "open"
          ? "Ready."
          : status === "connecting"
            ? "Connecting…"
            : "Disconnected — start a new chat."}
      </p>
    </div>
  );
}

/** What a plan card needs from its pane (US-022): the approval gating it (if
 *  still pending), the responder, and the settled-card fallback that switches
 *  the live session off plan for the next turn. */
interface PlanCtx {
  approvalFor: (toolUseId: string) => PendingApproval | undefined;
  respond: (id: string, decision: PermissionDecision) => void;
  proceed: () => void;
  inPlanMode: boolean;
  busy: boolean;
}

/** A transcript item, wrapped in a `data-turn` anchor when it's a user
 *  prompt so the activity spine (US-016) can scroll to it. */
function Anchored({ item, planCtx }: { item: ChatItem; planCtx?: PlanCtx }) {
  if (item.role !== "user") return <Item item={item} planCtx={planCtx} />;
  return (
    <div data-turn={item.id} className="scroll-mt-4">
      <Item item={item} planCtx={planCtx} />
    </div>
  );
}

/** Render one transcript item by role. */
function Item({ item, planCtx }: { item: ChatItem; planCtx?: PlanCtx }) {
  switch (item.role) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "reasoning":
      return <ReasoningEntry text={item.text} />;
    case "tool": {
      const plan = planMarkdown(item);
      return plan != null ? (
        <PlanCard item={item} plan={plan} ctx={planCtx} />
      ) : (
        <ToolCard item={item} />
      );
    }
    case "approval":
      return <ApprovalEntry item={item} />;
    case "system":
      return (
        <div className="text-[11px] text-muted-foreground">
          Session started{item.model ? ` · ${item.model}` : ""}
          {item.cwd ? ` · ${item.cwd}` : ""}
        </div>
      );
    case "mode": {
      const m = PERMISSIONS.find((p) => p.value === item.mode);
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {m && <m.icon className="size-3 shrink-0" />}
          <span>Permission mode → {m?.label ?? item.mode}</span>
        </div>
      );
    }
    case "result":
      return (
        <div className="flex items-center gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <span>Turn complete</span>
          {item.costUsd != null && <span>· ${item.costUsd.toFixed(4)}</span>}
          {item.durationMs != null && <span>· {(item.durationMs / 1000).toFixed(1)}s</span>}
          {item.numTurns != null && <span>· {item.numTurns} steps</span>}
        </div>
      );
    case "error":
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {item.message}
        </div>
      );
    default:
      return null;
  }
}

/** Assistant prose — markdown rendered to React elements (no raw HTML), styled
 *  through semantic tokens via descendant variants so it inherits the theme.
 *  Re-parsing the whole text per streamed delta is fine at chat-message sizes. */
function Markdown({ text }: { text: string }) {
  return (
    <div
      className={cn(
        "min-w-0 text-sm leading-relaxed text-foreground",
        "[&_p]:my-1.5 first:[&_p]:mt-0 last:[&_p]:mb-0",
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
        "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-px [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_hr]:my-3 [&_hr]:border-border",
        "[&_table]:my-2 [&_table]:text-xs [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Thinking/reasoning entry — muted and collapsed by default so the
 *  transcript reads as prose; expand to see the agent's deliberation. */
function ReasoningEntry({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 transition-colors hover:text-foreground"
      >
        <ChevronDown
          className={cn("size-3 transition-transform", !open && "-rotate-90")}
        />
        <span className="italic">Thinking</span>
      </button>
      {open && (
        <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

/** Coarse card categories for the icon — command/read/edit/mcp/web + fallback. */
type ToolCardKind = "command" | "read" | "edit" | "mcp" | "web" | "other";

const TOOL_ICONS: Record<ToolCardKind, LucideIcon> = {
  command: Terminal,
  read: FileText,
  edit: FilePenLine,
  mcp: Plug,
  web: Globe,
  other: Wrench,
};

function toolCardKind(name: string): ToolCardKind {
  if (name.startsWith("mcp__")) return "mcp";
  if (/^(Bash|BashOutput|KillShell)$/.test(name)) return "command";
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/.test(name)) return "read";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "edit";
  if (/^(WebFetch|WebSearch)$/.test(name)) return "web";
  return "other";
}

/** Best-effort one-line summary of a tool's input (the command, file, query…)
 *  for the collapsed header. Falls back to null → header shows the name only. */
function toolSummary(input: unknown): string | null {
  if (typeof input === "string") return input || null;
  if (input == null || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  // `skill`/`name` surface the Skill tool's target (its input has no command/
  // path), so a Skill card reads "Skill · polish-copy" instead of a bare "Skill".
  for (const key of ["command", "file_path", "pattern", "url", "query", "path", "skill", "name", "description", "prompt"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** The plan markdown carried by a plan-mode ExitPlanMode call — the signal a
 *  tool item should render as a plan card instead of a generic tool card.
 *  (Headless plan turns also Write a copy to ~/.claude/plans/; that stays a
 *  normal Write card — rendering both as plan cards would duplicate the plan.) */
function planMarkdown(item: Extract<ChatItem, { role: "tool" }>): string | null {
  if (item.name !== "ExitPlanMode") return null;
  const o =
    item.input && typeof item.input === "object"
      ? (item.input as Record<string, unknown>)
      : null;
  return o && typeof o.plan === "string" && o.plan.trim() ? o.plan : null;
}

/** Proposed-plan card (US-022): a plan-mode turn ends with ExitPlanMode whose
 *  input carries the full plan — the turn's real artifact, so it renders as a
 *  distinct bordered card, not a tool row or assistant bubble. While the plan
 *  approval is pending, the card's Proceed/Keep-planning answer it (approving
 *  exits plan mode CLI-side and the SAME turn continues into build); on a
 *  settled card still in plan mode, Proceed switches the session to
 *  Supervised for the next turn via the control channel. */
function PlanCard({
  item,
  plan,
  ctx,
}: {
  item: Extract<ChatItem, { role: "tool" }>;
  plan: string;
  ctx?: PlanCtx;
}) {
  const approval = ctx?.approvalFor(item.id);
  const proceedNextTurn = !approval && ctx?.inPlanMode === true && !ctx.busy;
  return (
    <div className="overflow-hidden rounded-lg border border-primary/40 bg-card">
      <div className="flex items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2">
        <ClipboardList className="size-3.5 shrink-0 text-primary" />
        <span className="text-xs font-medium text-foreground">Proposed plan</span>
        {approval && (
          <span className="ml-auto shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            Awaiting review
          </span>
        )}
      </div>
      <div className="max-h-96 overflow-y-auto px-3.5 py-2.5">
        <Markdown text={plan} />
      </div>
      {(approval || proceedNextTurn) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          {approval ? (
            <>
              <Button size="sm" onClick={() => ctx!.respond(approval.id, "accept")}>
                Proceed in build
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => ctx!.respond(approval.id, "decline")}
              >
                Keep planning
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Proceeding switches to Supervised and starts building now
              </span>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => ctx!.proceed()}>
                Proceed in build
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Switches this chat to Supervised for the next turn
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { role: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const kind = toolCardKind(item.name);
  const Icon = TOOL_ICONS[kind];
  // MCP tool ids read noisily (`mcp__server__tool`) — show `server · tool`.
  const displayName =
    kind === "mcp" ? item.name.slice(5).replace(/__/g, " · ") : item.name;
  const summary = toolSummary(item.input);
  const inputStr =
    typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2);
  // File edits carry their before/after right in the input — derive the
  // inline patch (US-021). Memoized: LCS on a big Write isn't free, and the
  // card re-renders on every streamed delta while the turn continues.
  const fileDiff = useMemo(
    () => (kind === "edit" ? buildFileDiff(item.name, item.input) : null),
    [kind, item.name, item.input],
  );
  return (
    <div className="rounded-lg border border-border bg-card text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">{displayName}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        {fileDiff && <DiffStat added={fileDiff.added} removed={fileDiff.removed} />}
        <span
          className={cn(
            "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            item.result == null
              ? "bg-primary/10 text-primary"
              : item.isError
                ? "bg-destructive/15 text-destructive"
                : "bg-muted text-muted-foreground",
          )}
        >
          {item.result == null ? "running" : item.isError ? "error" : "done"}
        </span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {fileDiff ? (
            fileDiff.lines ? (
              <DiffView diff={fileDiff} />
            ) : (
              /* Binary / huge writes degrade to a one-line summary. */
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate font-mono">{fileDiff.path}</span>
                <DiffStat added={fileDiff.added} removed={fileDiff.removed} />
                <span>
                  {fileDiff.degraded === "binary"
                    ? "binary content — diff not shown"
                    : "diff too large to render"}
                </span>
              </div>
            )
          ) : (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Input
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                {inputStr}
              </pre>
            </div>
          )}
          {item.result != null && (
            <div className="border-t border-border/60 pt-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Result{item.result.length > 4000 ? " (truncated)" : ""}
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
                {item.result.slice(0, 4000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** `+N −M` line counts for a file-edit card (collapsed header + degraded
 *  summary). Additions ride the emerald status green (the Onboarding/MCP
 *  precedent — there's no semantic "success" token); removals the
 *  destructive token. */
function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

/** Cap on rendered patch rows — a Write of a whole large file stays scrollable
 *  without mounting thousands of DOM nodes. */
const MAX_DIFF_ROWS = 600;

/** The inline patch inside an expanded file-edit card (US-021): red/green
 *  +/− rows in a bounded scroller, MultiEdit hunks separated by a ⋯ row.
 *  No modal, no side panel — the diff lives in the transcript. */
function DiffView({ diff }: { diff: FileDiff }) {
  const lines = diff.lines ?? [];
  const shown = lines.slice(0, MAX_DIFF_ROWS);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Diff
        </span>
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70">
          {diff.path}
        </span>
        <DiffStat added={diff.added} removed={diff.removed} />
      </div>
      <div className="max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/20 py-0.5 font-mono text-[11px] leading-5">
        {shown.map((l, i) =>
          l.type === "hunk" ? (
            <div key={i} className="border-y border-border/60 bg-muted/50 px-2 text-center text-muted-foreground/60">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "whitespace-pre px-2",
                l.type === "add" &&
                  "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
                l.type === "del" && "bg-destructive/10 text-destructive",
                l.type === "ctx" && "text-muted-foreground",
              )}
            >
              <span className="select-none opacity-60">
                {l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}
              </span>
              {l.text}
            </div>
          ),
        )}
        {lines.length > MAX_DIFF_ROWS && (
          <div className="px-2 py-1 text-muted-foreground">
            … {lines.length - MAX_DIFF_ROWS} more lines
          </div>
        )}
      </div>
    </div>
  );
}

/** Human labels + icons for the driver's coarse permission tool kinds. */
const APPROVAL_KINDS: Record<ToolPermissionKind, { label: string; icon: LucideIcon }> = {
  command: { label: "Run command", icon: Terminal },
  "file-read": { label: "Read file", icon: FileText },
  "file-change": { label: "Change file", icon: FilePenLine },
  other: { label: "Use tool", icon: Wrench },
};

/** How a resolved approval reads in the transcript. */
const RESOLUTION_LABELS: Record<Exclude<ApprovalResolution, "pending">, string> = {
  accept: "Approved",
  acceptForSession: "Always allowed this session",
  decline: "Declined",
  cancel: "Turn cancelled",
  dismissed: "Dismissed",
};

/** Supervised-mode approval prompt — swapped in for the composer's input
 *  while a permission request is pending (US-010). The four actions map 1:1
 *  to the driver's PermissionDecision; answering restores the composer. */
function ApprovalPanel({
  approval,
  count,
  respond,
}: {
  approval: PendingApproval;
  count: number;
  respond: (id: string, decision: PermissionDecision) => void;
}) {
  const meta = APPROVAL_KINDS[approval.toolKind] ?? APPROVAL_KINDS.other;
  const decide = (decision: PermissionDecision) => respond(approval.id, decision);
  if (approval.toolName === "ExitPlanMode") {
    // Plan approval (US-022): the plan itself renders as the card in the
    // transcript, so the panel is just the decision — no mono detail dump,
    // and no "always allow" (widening `other` over one plan gate is wrong).
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <ClipboardList className="size-4 shrink-0 text-primary" />
          <span className="text-sm font-medium text-foreground">Plan ready</span>
          {count > 1 && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
              1 of {count}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The agent proposed a plan — review the plan card above. Proceeding
          switches this chat to Supervised and starts building now.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => decide("accept")}>
            Proceed in build
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("decline")}>
            Keep planning
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => decide("cancel")}
          >
            Cancel turn
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-medium text-foreground">Permission needed</span>
        <span className="flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <meta.icon className="size-3" />
          {meta.label} · {approval.toolName}
        </span>
        {count > 1 && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            1 of {count}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{approval.summary}</p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-foreground">
        {approval.detail}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => decide("accept")}>
          Approve once
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("acceptForSession")}>
          Always allow this session
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("decline")}>
          Decline
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => decide("cancel")}
        >
          Cancel turn
        </Button>
      </div>
    </div>
  );
}

/** Approval events in the transcript — a compact work entry that shows the
 *  request and, once settled, how it resolved. */
function ApprovalEntry({ item }: { item: Extract<ChatItem, { role: "approval" }> }) {
  const meta = APPROVAL_KINDS[item.toolKind] ?? APPROVAL_KINDS.other;
  const pending = item.resolution === "pending";
  const approved = item.resolution === "accept" || item.resolution === "acceptForSession";
  // The plan gate reads in plan language (US-022) — "Use tool · ExitPlanMode
  // · Approved" would bury what actually happened.
  const isPlan = item.toolName === "ExitPlanMode";
  const Icon = isPlan ? ClipboardList : ShieldCheck;
  const resolutionLabel =
    item.resolution === "pending"
      ? isPlan
        ? "Awaiting review"
        : "Awaiting approval"
      : isPlan && item.resolution === "accept"
        ? "Proceeding in build"
        : isPlan && item.resolution === "decline"
          ? "Kept planning"
          : RESOLUTION_LABELS[item.resolution];
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Icon className={cn("size-3.5 shrink-0", pending && "text-primary")} />
      <span className="shrink-0">
        {isPlan ? (
          <span className="font-medium text-foreground">Proposed plan</span>
        ) : (
          <>
            {meta.label} · <span className="font-medium text-foreground">{item.toolName}</span>
          </>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono">{isPlan ? "" : item.summary}</span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          pending
            ? "bg-primary/10 text-primary"
            : approved
              ? "bg-muted text-muted-foreground"
              : "bg-destructive/15 text-destructive",
        )}
      >
        {resolutionLabel}
      </span>
    </div>
  );
}
