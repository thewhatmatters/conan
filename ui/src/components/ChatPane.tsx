import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ClipboardList,
  FilePenLine,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Loader2,
  Lock,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
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
import { basename } from "./DirBrowser.tsx";
import { useDirGit } from "../hooks/useDirGit.ts";

/**
 * Level-2 chat spike — the programmatic peer of the terminal surface.
 *
 * A custom transcript (rendered from the gateway's normalized agent events) +
 * a composer whose chips map to real `claude -p` flags. This is the t3-code
 * interaction model inside Conan's existing Tauri shell: no TUI, no xterm —
 * Conan drives `claude` headlessly and owns the rendering.
 *
 * Spike scope: Claude-only, message-level streaming, launch config fixed at the
 * first prompt. NOT yet wired into the shared event bus, so the Timeline/Usage
 * HUD don't light up from chat turns — that's the next increment.
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

export default function ChatPane({
  token,
  cwd,
  onState,
}: {
  token: string | null;
  /** The thread's working directory — its PROJECT's path (US-025: the project
   *  owns the path; threads never diverge from it). Sent with every prompt
   *  frame — the gateway pins the first one (US-001). */
  cwd?: string | null;
  onState?: (s: ThreadUiState) => void;
}) {
  const { items, busy, status, sessionId, pendingApproval, pendingApprovals, respondToApproval, send, interrupt } =
    useAgentChat(token);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(undefined);
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

  // Report thread state up to the sidebar. The parent's setter bails when
  // nothing changed, so an unstable onState identity can't loop renders.
  const firstUser = items.find((it) => it.role === "user");
  const title = firstUser && firstUser.role === "user" ? firstUser.text : null;
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
  }, [items, busy]);

  const effectiveCwd = cwd ?? null;
  // Branch/dirty for THIS thread's directory — per-thread, so a hidden thread
  // on another repo never shows the active thread's branch.
  const git = useDirGit(token, effectiveCwd);

  // The launch config is fixed at the first prompt (stream-json keeps one
  // model/permission-mode per process) — lock the chips once a turn is sent.
  const locked = firstUser != null;

  const submit = () => {
    if (!text.trim() || busy) return;
    send(text, { model, permissionMode: permission, cwd: effectiveCwd ?? undefined });
    setText("");
  };

  const selectPermission = (value: NonNullable<AgentOpts["permissionMode"]>) => {
    if (value === "bypassPermissions" && !fullAccessConfirmed.current) {
      setConfirmingFullAccess(true);
      return;
    }
    setPermission(value);
  };

  const modelLabel = MODELS.find((m) => m.value === model)?.label ?? "Default model";
  const perm = PERMISSIONS.find((p) => p.value === permission) ?? PERMISSIONS[1]!;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Transcript — aside-rooted so it inherits the themed 6px scrollbar. */}
      <aside
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {items.length === 0 ? (
            <EmptyState status={status} />
          ) : (
            items.map((it) => <Item key={it.id} item={it} />)
          )}
          {busy && <WorkingIndicator items={items} />}
        </div>
      </aside>

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
            <span className="text-[11px] text-muted-foreground">
              {status === "connecting" ? "connecting to agent…" : "agent disconnected"}
            </span>
          )}
        </div>
        <div className="mx-auto w-full max-w-3xl rounded-xl border border-border bg-card p-3 shadow-sm focus-within:border-primary/60">
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
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
                className="max-h-48 min-h-9 w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <div className="mt-2 flex items-center gap-2">
                <Chip icon={<Sparkles className="size-3.5" />} label={modelLabel} locked={locked}>
                  {MODELS.map((m) => (
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
                  locked={locked}
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
                    className="flex size-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90"
                  >
                    <Square className="size-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={!text.trim()}
                    aria-label="Send"
                    className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
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
                setPermission("bypassPermissions");
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
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none",
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
        no terminal required. {status === "open" ? "Ready." : "Connecting…"}
      </p>
    </div>
  );
}

/** Render one transcript item by role. */
function Item({ item }: { item: ChatItem }) {
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
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return <ApprovalEntry item={item} />;
    case "system":
      return (
        <div className="text-[11px] text-muted-foreground">
          Session started{item.model ? ` · ${item.model}` : ""}
          {item.cwd ? ` · ${item.cwd}` : ""}
        </div>
      );
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
  for (const key of ["command", "file_path", "pattern", "url", "query", "path", "description", "prompt"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
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
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Input
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
              {inputStr}
            </pre>
          </div>
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
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <ShieldCheck className={cn("size-3.5 shrink-0", pending && "text-primary")} />
      <span className="shrink-0">
        {meta.label} · <span className="font-medium text-foreground">{item.toolName}</span>
      </span>
      <span className="min-w-0 flex-1 truncate font-mono">{item.summary}</span>
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
        {item.resolution === "pending" ? "Awaiting approval" : RESOLUTION_LABELS[item.resolution]}
      </span>
    </div>
  );
}
