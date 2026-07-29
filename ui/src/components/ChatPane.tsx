import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Eye,
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
  Paperclip,
  Plus,
  X,
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
  type ApprovalResolution,
  type ChatItem,
  type PendingApproval,
  type PermissionDecision,
  type ToolPermissionKind,
  type OutgoingImage,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { cn } from "../lib/utils.ts";
import { apiBase } from "../lib/gateway.ts";
import { ProviderModelPicker } from "./ProviderModelPicker.tsx";
import { basename } from "./DirBrowser.tsx";
import { useDirGit } from "../hooks/useDirGit.ts";
import type { SkillFiredEvent } from "../hooks/useTasks.ts";
import type { SkillEntry } from "../hooks/useSkills.ts";
import {
  useProviders,
  type AgentCapabilities,
  type ProviderStatus,
} from "../hooks/useProviders.ts";
import ActivitySpine, {
  type SpineTurn,
  type SpineViewport,
} from "./ActivitySpine.tsx";
import ThreadToolbar from "./ThreadToolbar.tsx";
import SurfacePanel from "./SurfacePanel.tsx";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip.tsx";
import { ProgressCircle } from "./charts/ProgressCircle.tsx";
import { buildFileDiff } from "../lib/diff.ts";
import { chunkTranscript, type ToolItem } from "../lib/worklog.ts";
import { DiffView, DiffStat } from "./DiffView.tsx";

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

/** Display metadata per KNOWN permission-mode id (US-009). The chip's
 *  OPTIONS — which modes exist, their labels and hints — come from the
 *  provider's `capabilities.permissionModes`, never from a hard-coded list;
 *  this map only decorates a mode id with an icon (and labels the transcript's
 *  after-the-fact mode rows). Ids are provider vocabulary, not provider
 *  branches: an unknown id still renders, with a shield and its raw id. */
const MODE_META: Record<string, { label: string; icon: LucideIcon }> = {
  // Claude + grok vocabulary
  plan: { label: "Plan", icon: ClipboardList },
  default: { label: "Supervised", icon: ShieldCheck },
  acceptEdits: { label: "Accept edits", icon: FilePenLine },
  bypassPermissions: { label: "Full access", icon: ShieldAlert },
  // Codex sandbox vocabulary
  "read-only": { label: "Read only", icon: Eye },
  "workspace-write": { label: "Workspace write", icon: FilePenLine },
  "danger-full-access": { label: "Full access", icon: ShieldAlert },
};
const modeIcon = (id: string): LucideIcon => MODE_META[id]?.icon ?? ShieldCheck;

/** Modes that run everything unguarded — destructive styling + the one-time
 *  confirm dialog, whatever the provider calls them. */
const DANGER_MODE_IDS = new Set(["bypassPermissions", "danger-full-access"]);

/** Pre-fetch fallback, mirroring Claude's verified descriptor
 *  (CLAUDE_CAPABILITIES in src/agent/claude.ts): until the provider list or
 *  the session's own capabilities frame lands, the chip needs a non-blank
 *  shape for the default provider. Live capabilities always win. */
const FALLBACK_CAPABILITIES: AgentCapabilities = {
  imageInput: true,
  streamingDeltas: true,
  interactiveApproval: true,
  livePermissionSwitch: true,
  costUsd: true,
  reasoningText: false,
  resume: true,
  contextWindowTokens: null,
  modelSelection: true,
  models: [
    { value: null, label: "Default model", description: "Opus 5 · best for everyday, complex tasks" },
    { value: "opus", label: "Opus", description: "Opus 5 · 1M context" },
    { value: "fable", label: "Fable", description: "Fable 5 · most capable, longest-running tasks" },
    { value: "sonnet", label: "Sonnet", description: "Sonnet 5 · efficient for routine tasks" },
    { value: "haiku", label: "Haiku", description: "Haiku 4.5 · fastest for quick answers" },
  ],
  permissionModes: [
    { id: "plan", label: "Plan", description: "Read-only — ends with a proposed plan" },
    { id: "default", label: "Supervised", description: "Asks before running tools" },
    { id: "acceptEdits", label: "Accept edits", description: "Auto-approves file edits" },
    { id: "bypassPermissions", label: "Full access", description: "Runs every tool without prompting" },
  ],
  effortModes: [
    { id: "think", label: "Think", description: "Ask Claude to reason carefully" },
    { id: "ultrathink", label: "Ultrathink", description: "Ask Claude to reason deeply" },
  ],
};

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
  /** The agent provider driving this pane (US-011) — the chip's pick on a
   *  fresh thread, the saved provider on a reopened one. Feeds the sidebar
   *  avatar so a Codex thread reads X from its very first turn. */
  provider: string;
}

/** Reopened-thread context (US-015): the saved session to reconstruct and
 *  continue. `model` is the saved launch model, re-applied on resume so the
 *  continued conversation stays on the model it started with. */
export interface ResumeTarget {
  sessionId: string;
  model: string | null;
  effort: string | null;
  /** The provider that created the thread (US-008) — shown locked in the
   *  chip; the gateway resumes on it regardless. Null → claude (pre-
   *  migration rows). */
  provider: string | null;
}

/** One reconstructed history entry from GET /api/agent/threads/:id/transcript
 *  (mirrors the gateway's HistoryItem). */
type HistoryItem =
  | { role: "user" | "assistant" | "reasoning"; text: string; ts?: number | null }
  | { role: "tool"; id: string; name: string; input: unknown; result: string | null; isError: boolean; ts?: number | null };

export default function ChatPane({
  token,
  cwd,
  projectId,
  projectName,
  titleOverride,
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
  /** Project display name (folder basename) — shown as a breadcrumb crumb
   *  before the thread title in the toolbar. */
  projectName?: string | null;
  /** Persisted thread title (DB `chat_thread.title`) — the authoritative
   *  display title, so a sidebar rename shows in the toolbar too. Falls back to
   *  the first-prompt derivation when absent (a fresh, unsaved thread). */
  titleOverride?: string | null;
  /** Saved session to reopen (US-015): its transcript is reconstructed above
   *  the live items and the first prompt launches with `--resume`. */
  resume?: ResumeTarget | null;
  /** Latest `{type:'skill-fired'}` app-WS broadcast (US-017) — each pane
   *  filters by its OWN session id, so a firing lands on the right spine even
   *  with several threads mounted. */
  lastSkillFired?: SkillFiredEvent | null;
  onState?: (s: ThreadUiState) => void;
  /** Thread creation time — the spine's top time label. */
  createdAt?: number | null;
}) {
  const {
    items,
    contextTokens,
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
    reportError,
    capabilities: sessionCaps,
  } = useAgentChat(token);
  const [text, setText] = useState("");
  const [model, setModel] = useState<string | undefined>(undefined);
  // Provider chip selection (US-008) — which agent CLI a FRESH thread
  // launches on. A reopened thread ignores this: its saved provider wins.
  const [provider, setProvider] = useState<string>("claude");
  // Permission-mode id in the PROVIDER's vocabulary (US-009) — one of the
  // active capability descriptor's permissionModes ids.
  const [permission, setPermission] = useState<string>("default");
  // Reasoning-effort id in the PROVIDER's vocabulary (US-008), or "" for no
  // override (the provider's default). effortModes lists only the override
  // levels; "Default" is their absence.
  const [effort, setEffort] = useState<string>("");
  // Pending @-pins (US-010): file content to attach to the NEXT turn. Bounded
  // server-side at turn time; `truncated` is set when the read hit its cap so
  // the transcript can say so.
  const [pins, setPins] = useState<PendingPin[]>([]);
  // Pasted images staged for the NEXT turn (US image-paste). base64 + media
  // type; the gateway validates/bounds/writes the per-provider temp file. Only
  // accepted when the active provider's capabilities.imageInput is true.
  const [images, setImages] = useState<OutgoingImage[]>([]);
  const [branchInfo, setBranchInfo] = useState<{
    repo: boolean;
    current: string | null;
    branches: string[];
  } | null>(null);
  const [branchPick, setBranchPick] = useState<{
    branch: string;
    createNew: boolean;
  } | null>(null);
  // A fresh worktree selection becomes this pane's real cwd at first send.
  // The parent still supplies the project root, while every thread-scoped
  // surface/indicator must follow the launched session directory.
  const [launchedCwd, setLaunchedCwd] = useState<string | null>(null);
  const [showFreshDepsHint, setShowFreshDepsHint] = useState(false);
  const branchLaunchPending = useRef(false);
  // Full-access one-time confirm: selecting a DANGER_MODE_IDS mode holds the
  // pick here until the dialog confirms it once per thread; declining reverts.
  const [confirmingDangerMode, setConfirmingDangerMode] = useState<string | null>(null);
  const fullAccessConfirmed = useRef(false);
  // Surface panel (Conan Surfaces US-001): per-thread, in-memory — ChatPane
  // instances are mounted-but-hidden per thread, so this state survives
  // thread switches. Width lives here (not in SurfacePanel) because the
  // composer offsets itself by it to keep the F8 axis alignment.
  const [surfacesOpen, setSurfacesOpen] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(420);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const spineJumpFrameRef = useRef<number | null>(null);
  // Frosted composer floats over the transcript, so the scroll content pads
  // its own foot by the composer's live height to keep the last message clear.
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  // Whether the view is pinned to the bottom. Scrolling up releases the pin
  // (so streaming doesn't yank the user back down); scrolling back near the
  // bottom re-engages it.
  const pinnedRef = useRef(true);

  // Track the floating composer's height so the transcript can pad its foot by
  // exactly that amount — messages scroll behind the frosted glass, never under it.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setComposerHeight(el.offsetHeight));
    ro.observe(el);
    setComposerHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

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
              : { id: `h${i}`, role: it.role, text: it.text, ts: it.ts },
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

  // The provider this pane is (or will be) driving — a reopened thread's
  // saved provider always wins over the chip state (US-008). Hoisted above
  // the state report so the sidebar avatar tracks it live (US-011).
  const effectiveProviderId = resume ? resume.provider ?? "claude" : provider;

  // Report thread state up to the sidebar. The parent's setter bails when
  // nothing changed, so an unstable onState identity can't loop renders.
  const firstUser = items.find((it) => it.role === "user");
  // Title: the first user prompt — from the live items, or the restored history
  // for a resumed thread (otherwise the toolbar/sidebar read "New chat" on
  // reopen). Capped at 256 so a pasted wall of text can't blow out the bar.
  const titleSource = firstUser ?? history.find((it) => it.role === "user");
  const derivedTitle =
    titleSource && titleSource.role === "user" ? titleSource.text.slice(0, 256) : null;
  // A persisted title (incl. a sidebar rename) wins over the first-prompt
  // derivation, so the toolbar and sidebar never disagree.
  const title = titleOverride ?? derivedTitle;
  useEffect(() => {
    onState?.({
      status,
      busy,
      awaitingApproval: pendingApproval != null,
      title,
      sessionId,
      provider: effectiveProviderId,
    });
  }, [status, busy, pendingApproval, title, sessionId, effectiveProviderId, onState]);

  // Stick to the bottom as the transcript grows — unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items, history, busy]);

  const effectiveCwd = launchedCwd ?? cwd ?? null;

  // Files this thread's edit tools touched (Conan Surfaces US-005) — the Diff
  // surface's path set. Extracted from BOTH the restored history and the live
  // items (the same tool items the transcript renders), deduped in first-touch
  // order. DiffSurface keys its refetch on the joined content, so the fresh
  // array identity each render doesn't spam git.
  const touchedPaths = useMemo(() => {
    const seen = new Set<string>();
    for (const it of [...history, ...items]) {
      if (it.role !== "tool" || !/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(it.name))
        continue;
      const o =
        it.input && typeof it.input === "object"
          ? (it.input as Record<string, unknown>)
          : null;
      const p =
        o &&
        (typeof o.file_path === "string"
          ? o.file_path
          : typeof o.notebook_path === "string"
            ? o.notebook_path
            : null);
      if (p) seen.add(p);
    }
    return [...seen];
  }, [history, items]);
  // Branch/dirty for THIS thread's directory — per-thread, so a hidden thread
  // on another repo never shows the active thread's branch.
  const git = useDirGit(token, effectiveCwd);

  // `@` files/folders autocomplete (US-018) — bounded recursive search under
  // THIS thread's cwd. The inserted `@path` is a reference only; the agent
  // reads the file itself (no content pinning).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the composer to fit its content (up to max-h-48), so long input
  // stays readable. Anchored at bottom-0, the composer expands upward.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [text]);
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

  useEffect(() => {
    if (locked || !token || !effectiveCwd) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          apiBase() + `/api/fs/branches?cwd=${encodeURIComponent(effectiveCwd)}`,
          { headers: { "x-conan-token": token } },
        );
        if (!r.ok) return;
        const data = (await r.json()) as {
          repo: boolean;
          current: string | null;
          branches: string[];
        };
        if (!cancelled) {
          setBranchInfo(data);
          setBranchPick(
            data.repo && data.current
              ? { branch: data.current, createNew: false }
              : null,
          );
        }
      } catch {
        // Match the existing git indicator: an unavailable probe hides the chip.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locked, token, effectiveCwd]);

  // Provider chip data (US-008): the registry's install probe, shared across
  // panes. Until the fetch lands (or if the gateway is unreachable) the chip
  // falls back to a Claude-only entry so it's never blank.
  const providerList = useProviders(token);
  const providerMeta: Pick<ProviderStatus, "id" | "name" | "avatarLetter" | "binary"> =
    providerList.find((p) => p.id === effectiveProviderId) ??
    (effectiveProviderId === "claude"
      ? { id: "claude", name: "Claude Code", avatarLetter: "C", binary: "claude" }
      : {
          id: effectiveProviderId,
          name: effectiveProviderId.charAt(0).toUpperCase() + effectiveProviderId.slice(1),
          avatarLetter: effectiveProviderId.charAt(0).toUpperCase(),
          // Pre-fetch fallback only: every shipped provider's id matches its
          // binary, and the registry's real value wins as soon as it lands.
          binary: effectiveProviderId,
        });
  const selectProvider = (id: string) => {
    setProvider(id);
    // The model chip's aliases (opus/sonnet/haiku) are Claude vocabulary, so a
    // provider without its own model picker must launch on its default. Read
    // the capability rather than the provider name — the registry is the only
    // place that should know which providers those are.
    const next = providerList.find((p) => p.id === id)?.capabilities;
    if (next && !next.modelSelection) setModel(undefined);
    // Effort ids are provider vocabulary (claude "ultrathink" vs codex "high"),
    // so a switch can't carry the old pick — fall back to the default.
    setEffort("");
  };
  // The fused picker commits a provider + model in one action. selectProvider
  // first (it resets model/effort for the provider's vocabulary), then apply
  // the explicit model pick on top — claude keeps it, no-model providers get
  // undefined either way.
  const selectProviderModel = (id: string, m: string | undefined) => {
    selectProvider(id);
    setModel(m);
  };

  // The active capability descriptor (US-009): once the session's driver is
  // built the gateway's capabilities frame is authoritative; before that, the
  // registry's descriptor for the chip's provider; a Claude-shaped fallback
  // covers the pre-fetch window. Everything below adapts to THIS — the
  // permission chip options, the live-switch honesty note, the approval UI —
  // never to a provider name.
  const caps: AgentCapabilities =
    sessionCaps ??
    providerList.find((p) => p.id === effectiveProviderId)?.capabilities ??
    FALLBACK_CAPABILITIES;

  // Keep the mode pick valid for the active provider: switching the chip to
  // codex must not leave a Claude-vocabulary id (codex has no "default") —
  // land on the provider's own default, else its FIRST mode (each descriptor
  // leads with its most restrictive option, so the reset is the safe floor).
  useEffect(() => {
    if (!caps.permissionModes.some((m) => m.id === permission)) {
      setPermission(
        (caps.permissionModes.find((m) => m.id === "default") ?? caps.permissionModes[0])
          ?.id ?? "default",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps, permission]);

  // Send an arbitrary prompt through the same launch config as the composer.
  // Returns false when a send can't happen (busy / not open / history loading)
  // so the caller can decide whether to clear its input. Used by the composer
  // submit and by prompt-kind toolbar actions.
  const sendPrompt = (promptText: string, onSent?: () => void): boolean => {
    const t = promptText.trim();
    if (
      !t ||
      busy ||
      branchLaunchPending.current ||
      status !== "open" ||
      historyState === "loading"
    )
      return false;
    branchLaunchPending.current = true;
    void (async () => {
      let launchCwd = effectiveCwd ?? undefined;
      if (
        !locked &&
        effectiveCwd &&
        branchPick &&
        branchPick.branch !== branchInfo?.current
      ) {
        try {
          const r = await fetch(apiBase() + "/api/agent/worktrees", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-conan-token": token ?? "",
            },
            body: JSON.stringify({
              cwd: effectiveCwd,
              branch: branchPick.branch,
              createBranch: branchPick.createNew || undefined,
            }),
          });
          const data = (await r.json()) as {
            path?: string;
            freshDeps?: boolean;
            error?: string;
          };
          if (!r.ok || !data.path) {
            reportError(data.error ?? "Could not prepare the selected branch.");
            branchLaunchPending.current = false;
            return;
          }
          launchCwd = data.path;
          setLaunchedCwd(data.path);
          if (data.freshDeps) setShowFreshDepsHint(true);
        } catch {
          reportError("Could not prepare the selected branch.");
          branchLaunchPending.current = false;
          return;
        }
      }
      send(t, {
        model: resume ? resume.model ?? undefined : model,
        permissionMode: effectiveMode,
        effort: resume?.effort ?? undefined,
        cwd: launchCwd,
        projectId: projectId ?? undefined,
        resume: resume && historyState === "found" ? resume.sessionId : undefined,
        provider: effectiveProviderId,
      }, pins.map((p) => ({
        type: "file" as const,
        path: p.path,
        content: p.content,
        truncated: p.truncated,
      })), images);
      setPins((prev) => prev.filter((p) => p.keep));
      setImages([]);
      branchLaunchPending.current = false;
      onSent?.();
    })();
    return true;
  };

  const submit = () => {
    sendPrompt(text, () => setText(""));
  };

  const selectPermission = (value: string) => {
    if (DANGER_MODE_IDS.has(value) && !fullAccessConfirmed.current) {
      setConfirmingDangerMode(value);
      return;
    }
    applyPermission(value);
  };

  // Pre-launch the chip sets the local launch config; once the session exists
  // the switch rides the driver (the US-022 path) — live for Claude, honestly
  // next-turn for codex/grok (each turn is a fresh process there, so the
  // driver confirms the change for its next spawn). No optimistic update on
  // the live path — the chip follows the confirmed `permission-mode` event,
  // and a failed switch (error item) leaves it on the prior mode.
  const applyPermission = (value: string) => {
    if (sessionId != null) setPermissionMode(value);
    else setPermission(value);
  };

  // The indicator follows the LIVE mode once the session reports one — a
  // mid-session switch (the plan card's "Proceed in build", US-022) moves the
  // locked chip off Plan so it never lies about what the agent may do.
  const effectiveMode = liveMode ?? permission;
  // The chip's face: the active mode's descriptor entry. An id the descriptor
  // doesn't list (shouldn't happen — drivers report their own vocabulary)
  // still renders honestly via MODE_META/raw-id instead of lying.
  const perm = caps.permissionModes.find((m) => m.id === effectiveMode) ?? {
    id: effectiveMode,
    label: MODE_META[effectiveMode]?.label ?? effectiveMode,
    description: "",
  };
  const PermIcon = modeIcon(perm.id);

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
      turnGroups.push({ id: it.id, text: it.text, ticks: [], ts: it.ts });
    } else if (it.role === "assistant" && it.text) {
      // First reply line of the turn — previewed in the spine's hover card.
      const group = turnGroups[turnGroups.length - 1];
      if (group && !group.reply) group.reply = it.text;
    } else if (it.role === "tool" && it.name !== "Skill") {
      const group = turnGroups[turnGroups.length - 1];
      if (group) {
        const summary = toolSummary(it.input);
        group.ticks.push({
          kind: "tool",
          label: summary ? `${it.name} · ${summary}` : it.name,
          id: it.id,
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
  const [spinePositions, setSpinePositions] = useState<Record<string, number>>(
    {},
  );
  const [spineViewportOffsets, setSpineViewportOffsets] = useState<
    Record<string, number>
  >({});
  const turns: SpineTurn[] = turnGroups.map((g, i) => {
    const skills = firedSkills.filter((f) => f.turnIndex === i);
    const measured = {
      ...g,
      position: spinePositions[g.id],
      viewportOffset: spineViewportOffsets[g.id],
      ticks: g.ticks.map((tick) => ({
        ...tick,
        position: tick.id ? spinePositions[tick.id] : spinePositions[g.id],
        viewportOffset: tick.id
          ? spineViewportOffsets[tick.id]
          : spineViewportOffsets[g.id],
      })),
    };
    return skills.length === 0
      ? measured
      : {
          ...measured,
          ticks: [
            ...skills.map((f) => ({
              kind: "skill" as const,
              label: f.skill,
              position: spinePositions[g.id],
              viewportOffset: spineViewportOffsets[g.id],
            })),
            ...measured.ticks,
          ],
        };
  });
  // Eased scroll to an absolute scrollTop — the single motion primitive behind
  // every discrete spine navigation (tick click, range jump, Present), so the
  // transcript, ticks, and blue pill always glide together instead of teleporting.
  const animateScrollTo = useCallback((destination: number, duration = 380) => {
    const el = scrollRef.current;
    if (!el) return;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const dest = Math.max(0, Math.min(destination, maxTop));
    const origin = el.scrollTop;
    const distance = dest - origin;
    if (spineJumpFrameRef.current != null)
      cancelAnimationFrame(spineJumpFrameRef.current);
    // Any spine navigation is an explicit move away from Present — release the
    // stick-to-bottom pin so a streaming delta doesn't yank us back mid-glide.
    pinnedRef.current = false;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || Math.abs(distance) < 1) {
      el.scrollTop = dest;
      spineJumpFrameRef.current = null;
      return;
    }
    const started = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      el.scrollTop = origin + distance * eased;
      if (progress < 1) {
        spineJumpFrameRef.current = requestAnimationFrame(animate);
      } else {
        spineJumpFrameRef.current = null;
      }
    };
    spineJumpFrameRef.current = requestAnimationFrame(animate);
  }, []);
  const jumpToTurn = (id: string) => {
    // `scrollIntoView` can choose an ancestor outside the transcript; a measured
    // local target guarantees the clicked tick, viewport, and pill share one motion.
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(
      `[data-turn="${CSS.escape(id)}"]`,
    );
    if (!el || !target) return;
    const top =
      target.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop;
    animateScrollTo(top);
  };
  const scrollFromSpine = useCallback(
    (top: number, smooth = false) => {
      const el = scrollRef.current;
      if (!el) return;
      const destination = top * el.scrollHeight;
      // Dragging the pill needs frame-exact tracking (instant); discrete jumps
      // (range dropdown, chevrons, Present) glide so the motion reads clearly.
      if (smooth) {
        animateScrollTo(destination);
        return;
      }
      if (spineJumpFrameRef.current != null) {
        cancelAnimationFrame(spineJumpFrameRef.current);
        spineJumpFrameRef.current = null;
      }
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(destination, maxTop));
    },
    [animateScrollTo],
  );

  // Spine minimap viewport — the scroller's visible window as 0–1 fractions.
  // Epsilon-gated so 60Hz scroll events don't re-render the pane per frame.
  const [spineViewport, setSpineViewport] = useState<SpineViewport | null>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const updateSpineViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.scrollHeight <= 0) return;
    setCanScrollUp(el.scrollTop > 1);
    setCanScrollDown(
      el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    );
    const top = el.scrollTop / el.scrollHeight;
    const height = Math.min(el.clientHeight / el.scrollHeight, 1);
    setSpineViewport((prev) =>
      prev &&
      Math.abs(prev.top - top) < 0.004 &&
      Math.abs(prev.height - height) < 0.004
        ? prev
        : { top, height },
    );
    const scrollerTop = el.getBoundingClientRect().top;
    const positions: Record<string, number> = {};
    const viewportOffsets: Record<string, number> = {};
    el.querySelectorAll<HTMLElement>("[data-spine-anchor]").forEach((node) => {
      const id = node.dataset.spineAnchor;
      if (!id) return;
      const nodeTop = node.getBoundingClientRect().top;
      positions[id] = Math.max(
        0,
        Math.min(
          1,
          (nodeTop - scrollerTop + el.scrollTop) /
            el.scrollHeight,
        ),
      );
      viewportOffsets[id] = (nodeTop - scrollerTop) / el.clientHeight;
    });
    setSpinePositions((prev) => {
      const keys = Object.keys(positions);
      if (
        keys.length === Object.keys(prev).length &&
        keys.every(
          (key) =>
            prev[key] != null &&
            Math.abs((prev[key] ?? 0) - (positions[key] ?? 0)) < 0.0005,
        )
      )
        return prev;
      return positions;
    });
    setSpineViewportOffsets((prev) => {
      const keys = Object.keys(viewportOffsets);
      if (
        keys.length === Object.keys(prev).length &&
        keys.every(
          (key) =>
            prev[key] != null &&
            Math.abs(
              (prev[key] ?? 0) - (viewportOffsets[key] ?? 0),
            ) < 0.004,
        )
      )
        return prev;
      return viewportOffsets;
    });
  }, []);
  useEffect(() => {
    updateSpineViewport();
  }, [items.length, history.length, updateSpineViewport]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateSpineViewport);
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [updateSpineViewport]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 bg-background">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ThreadToolbar
          token={token}
          cwd={effectiveCwd}
          projectId={projectId ?? null}
          projectName={projectName ?? null}
          title={title}
          onSendPrompt={sendPrompt}
          surfacesOpen={surfacesOpen}
          onToggleSurfaces={() => setSurfacesOpen((o) => !o)}
        />
        <div className="flex min-h-0 flex-1">
      {/* Transcript — aside-rooted; the activity spine sits to its RIGHT and is
          the primary scroll affordance, so the native scrollbar is hidden. */}
      <div className="relative min-h-0 min-w-0 flex-1">
        <aside
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            updateSpineViewport();
          }}
          className="absolute inset-0 overflow-auto no-native-scrollbar"
        >
          <div className="w-full pl-16">
            <div
              className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6"
              style={{ paddingBottom: composerHeight + 24 }}
            >
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
          <GroupedTranscript
            items={history}
            liveActive={false}
            planCtx={planCtx}
            caps={caps}
          />
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
            <EmptyState status={status} binary={providerMeta.binary} />
          ) : (
            <GroupedTranscript
              items={items}
              liveActive={busy}
              planCtx={planCtx}
              caps={caps}
            />
          )}
            {busy && <WorkingIndicator items={items} streaming={caps.streamingDeltas} />}
            </div>
          </div>
        </aside>
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent transition-opacity duration-200",
            canScrollUp ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-background to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      {/* Activity spine (US-016) — RIGHT side, primary scroll affordance;
          internals unchanged so drag/jump/pill behave as the working version. */}
      <ActivitySpine
        turns={turns}
        onJump={jumpToTurn}
        onViewportChange={scrollFromSpine}
        viewport={spineViewport}
      />
        </div>

      {/* Jump-to-present pill — surfaces only when the transcript is scrolled up
          off the bottom, floating just above the composer. Matches the spine's
          "Present" affordance; re-pins to the bottom via the shared eased glide. */}
      {canScrollDown && (
        <button
          type="button"
          aria-label="Jump to present"
          onClick={() => animateScrollTo(scrollRef.current?.scrollHeight ?? 0)}
          style={{ bottom: composerHeight + 12 }}
          className="absolute left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className="size-3.5" />
          Jump to present
        </button>
      )}

      {/* Composer (Studio redesign, Figma 9:189) — ONE rounded card: a darker
          input region (textarea + thread-context chips INSIDE it) over a
          footer row on the card chrome (+ · provider/model · permission ·
          effort · send). cwd and branch describe the conversation, so they
          ride inside the input region rather than a separate row above. */}
        <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-4 pb-4">
        {showFreshDepsHint && (
          <div className="pointer-events-auto mx-auto mb-1.5 flex w-full max-w-3xl items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              Fresh worktree — dependencies not installed
            </span>
            <button
              type="button"
              aria-label="Dismiss dependencies hint"
              onClick={() => setShowFreshDepsHint(false)}
              className="cursor-pointer rounded p-0.5 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
        <div className="pointer-events-auto relative mx-auto w-full max-w-3xl overflow-hidden rounded-3xl border border-border/70 bg-card/70 shadow-lg backdrop-blur-xl focus-within:border-primary/60">
          {!pendingApproval && <AutocompleteOverlay ac={ac} />}
          {/* Approval UI only where the provider HAS an approval channel
              (US-009): codex/grok never emit permission-requests, and the
              capability gate keeps that contract explicit. */}
          {pendingApproval && caps.interactiveApproval ? (
            /* Supervised mode: the input area becomes the approval prompt —
               the turn is blocked on this decision, so typing can wait. */
            <div className="p-3">
              <ApprovalPanel
                approval={pendingApproval}
                count={pendingApprovals.length}
                respond={respondToApproval}
              />
            </div>
          ) : (
            <>
              {/* Input region — a shade darker than the card chrome, textarea
                  plus the thread-context chips at its foot. */}
              <div className="flex flex-col rounded-3xl bg-background/50 px-4 pb-3 pt-4">
              {/* Pending pasted images — thumbnails, each removable, staged for
                  the next turn (gateway bounds them). */}
              {images.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {images.map((img, i) => (
                    <span key={i} className="group/img relative">
                      <img
                        src={`data:${img.mediaType};base64,${img.data}`}
                        alt="pasted"
                        className="size-14 rounded-md border border-border object-cover"
                      />
                      <button
                        type="button"
                        aria-label="Remove image"
                        onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                        className="absolute -right-1.5 -top-1.5 hidden size-4 items-center justify-center rounded-full bg-card ring-1 ring-border hover:text-destructive group-hover/img:flex"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* Pending pins (US-010) — staged for the next turn, each
                  removable. Truncation is shown here too, before send. */}
              {pins.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {pins.map((pin) => (
                    <span
                      key={pin.path}
                      title={pin.path}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
                    >
                      <Paperclip className="size-3 shrink-0" />
                      <span className="max-w-40 truncate">{basename(pin.path)}</span>
                      <span className="shrink-0 opacity-70">
                        {fmtBytes(pin.bytes)}
                        {pin.truncated ? " · truncated" : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${basename(pin.path)}`}
                        onClick={() => setPins((prev) => prev.filter((p) => p.path !== pin.path))}
                        className="cursor-pointer rounded p-0.5 hover:bg-muted hover:text-destructive"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={text}
                onPaste={(e) => {
                  // Paste-to-attach images (US image-paste), only where the
                  // provider actually accepts them — never a dead affordance.
                  if (!caps.imageInput) return;
                  const files = Array.from(e.clipboardData.files).filter((f) =>
                    f.type.startsWith("image/"),
                  );
                  if (files.length === 0) return;
                  e.preventDefault();
                  for (const file of files.slice(0, 4)) {
                    const reader = new FileReader();
                    reader.onload = () => {
                      const url = String(reader.result);
                      const comma = url.indexOf(",");
                      if (comma < 0) return;
                      setImages((prev) =>
                        prev.length >= 4
                          ? prev
                          : [...prev, { mediaType: file.type, data: url.slice(comma + 1) }],
                      );
                    };
                    reader.readAsDataURL(file);
                  }
                }}
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
                    : "How can I help you today?"
                }
                className="max-h-48 min-h-9 w-full resize-none bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
              {/* Thread context — INSIDE the input region (US-025 + Studio
                  redesign): the working directory (project-owned indicator)
                  and the branch (picker on drafts, indicator after launch). */}
              <div className="mt-3 flex items-center gap-2">
                <span
                  title={
                    (effectiveCwd ? `${effectiveCwd}\n` : "") +
                    (locked
                      ? "Locked for this session — the project owns the path"
                      : "Project directory")
                  }
                  className="flex min-w-0 cursor-default items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-sm text-foreground"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="max-w-40 truncate">
                    {effectiveCwd ? basename(effectiveCwd) : "Directory"}
                  </span>
                  {locked && <Lock className="size-3 shrink-0 opacity-60" />}
                </span>
                {!locked && branchInfo?.repo && branchPick ? (
                  <BranchPicker
                    info={branchInfo}
                    selection={branchPick}
                    onSelect={setBranchPick}
                  />
                ) : git?.available && git.branch ? (
                  <span
                    title={`${git.branch}${git.dirty ? ` · ${git.dirty} uncommitted` : ""}`}
                    className="inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-sm text-foreground"
                  >
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="max-w-48 truncate">
                      {git.branch}
                      {git.dirty ? "*" : ""}
                    </span>
                  </span>
                ) : null}
                {/* Add files — inline with the cwd/branch context chips, not
                    down in the footer, since it describes what rides along with
                    this message just like the directory + branch do. */}
                <PinPicker
                  token={token}
                  cwd={effectiveCwd}
                  disabled={status !== "open"}
                  onPin={(pin) =>
                    setPins((prev) =>
                      prev.some((p) => p.path === pin.path) ? prev : [...prev, pin],
                    )
                  }
                />
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
              </div>
              {/* Footer — on the card chrome: attach · provider/model ·
                  permission · effort, then context meter + send. 16/8 padding
                  per the Studio frame. */}
              <div className="flex items-center justify-between gap-2 px-4 py-2">
                <div className="flex min-w-0 items-center gap-1.5">
                {/* Fused provider + model picker (US-008 + model): one popover
                    — a provider rail + the browsed provider's OWN model list —
                    replacing the two separate chips. Each provider's models come
                    from its capabilities (Claude aliases, Codex's CLI cache,
                    Grok's `grok models`), so the panel is provider-specific, not
                    a shared Claude list. Locks with the launch config;
                    uninstalled providers stay listed but disabled. */}
                <ProviderModelPicker
                  providers={
                    providerList.length
                      ? providerList
                      : [
                          {
                            id: "claude",
                            name: "Claude Code",
                            avatarLetter: "C",
                            binary: "claude",
                            installed: true,
                            version: null,
                            capabilities: caps,
                          },
                        ]
                  }
                  activeProviderId={effectiveProviderId}
                  activeProviderName={providerMeta.name}
                  activeProviderLetter={providerMeta.avatarLetter}
                  model={resume ? resume.model ?? undefined : model}
                  effort={effort}
                  locked={locked}
                  onSelect={selectProviderModel}
                  onEffortSelect={setEffort}
                />
                {/* The active permission mode stays visible here whether or not the
                    dropdown is ever opened — the persistent indicator. Options come
                    from the provider's own capability descriptor (US-009): codex
                    lists its real sandbox policies and Supervised simply isn't
                    there — absent, not inert. */}
                <Chip
                  icon={<PermIcon className="size-3.5" />}
                  label={perm.label}
                  className={cn(
                    DANGER_MODE_IDS.has(perm.id) && "text-destructive hover:text-destructive",
                  )}
                >
                  {caps.permissionModes.map((p) => {
                    const OptIcon = modeIcon(p.id);
                    return (
                      <DropdownMenuItem key={p.id} onClick={() => selectPermission(p.id)}>
                        <OptIcon className="size-3.5 text-muted-foreground" />
                        <div className="flex flex-col">
                          <span>{p.label}</span>
                          <span className="text-[11px] text-muted-foreground">{p.description}</span>
                        </div>
                      </DropdownMenuItem>
                    );
                  })}
                  {!caps.livePermissionSwitch && sessionId != null && (
                    /* Honesty note (US-009): this provider can't switch a LIVE
                       turn — every turn is a fresh process, so a change here
                       genuinely applies from the next turn, and says so. */
                    <div className="max-w-56 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
                      Applies from the next turn — {providerMeta.name} can't
                      change a running session.
                    </div>
                  )}
                </Chip>
                {/* Reasoning effort now folds into the ProviderModelPicker as a
                    fly-out (provider · model · effort behind one trigger), so
                    there's no standalone effort chip here anymore. */}
                </div>
                {/* Right cluster: the context ring (rich hover card) + send. */}
                <div className="flex shrink-0 items-center gap-2">
                {contextTokens != null && (
                  <ContextMeter used={contextTokens} windowTokens={caps.contextWindowTokens} />
                )}
                {busy ? (
                  <button
                    onClick={interrupt}
                    aria-label="Stop"
                    title="Stop — cancel this turn (the conversation survives)"
                    className="flex size-8 cursor-pointer items-center justify-center rounded-lg bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Square className="size-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={submit}
                    disabled={!text.trim() || status !== "open" || historyState === "loading"}
                    aria-label="Send"
                    className="flex size-8 cursor-pointer items-center justify-center rounded-lg bg-brand text-brand-foreground transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-40"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                )}
                </div>
              </div>
            </>
          )}
        </div>
        </div>

      {/* One-time Full-access confirm — declining (or dismissing) reverts to
          the previously selected mode; confirming skips the dialog next time. */}
      <Dialog open={confirmingDangerMode != null} onOpenChange={(open) => !open && setConfirmingDangerMode(null)}>
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
            <Button variant="outline" size="sm" onClick={() => setConfirmingDangerMode(null)}>
              Keep {perm.label}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                fullAccessConfirmed.current = true;
                if (confirmingDangerMode) applyPermission(confirmingDangerMode);
                setConfirmingDangerMode(null);
              }}
            >
              Enable Full access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
      {surfacesOpen && (
        <SurfacePanel
          width={surfaceWidth}
          onWidthChange={setSurfaceWidth}
          onClose={() => setSurfacesOpen(false)}
          token={token}
          cwd={effectiveCwd}
          touchedPaths={touchedPaths}
        />
      )}
    </section>
  );
}

/**
 * Live turn indicator. A bare "Working…" reads as a hang on long turns (a
 * verification-heavy prompt can legitimately run for minutes), so this shows
 * elapsed time plus what the agent is doing right now — the last tool it
 * reached for. Dogfooding finding: the transcript looked frozen mid-turn.
 *
 * `streaming` mirrors `capabilities.streamingDeltas` (US-010): a
 * non-streaming provider (codex) emits NOTHING until the turn completes, so
 * this indicator is the turn's only liveness signal — never an idle caret
 * waiting for deltas that will never come — and says so on hover.
 */
function WorkingIndicator({ items, streaming }: { items: ChatItem[]; streaming: boolean }) {
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
      <span
        title={
          streaming
            ? undefined
            : "This agent sends its reply all at once — no text streams while it works"
        }
      >
        Working…
      </span>
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
          "flex cursor-default items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground",
          className,
        )}
      >
        {icon}
        {label}
        <Lock className="size-3.5 opacity-60" />
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg:first-child]:text-muted-foreground",
          className,
        )}
      >
        {icon}
        {label}
        <ChevronDown className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchPicker({
  info,
  selection,
  onSelect,
}: {
  info: { current: string | null; branches: string[] };
  selection: { branch: string; createNew: boolean };
  onSelect: (value: { branch: string; createNew: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const exists = info.branches.includes(trimmed);
  const invalid =
    trimmed.length > 0 &&
    (/\s|~|\^|:|\?|\*|\[|\\/.test(name) ||
      trimmed.includes("..") ||
      trimmed.startsWith("/") ||
      trimmed.endsWith("/"));
  const validation = exists ? "branch exists" : invalid ? "invalid name" : null;
  const canConfirm = trimmed.length > 0 && validation == null;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) {
          setCreating(false);
          setName("");
        }
      }}
    >
      <DropdownMenuTrigger
        title={`Branch: ${selection.branch}`}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-sm text-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-48 truncate">{selection.branch}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {!creating ? (
          <>
            {info.branches.map((branch) => (
              <DropdownMenuItem
                key={branch}
                onSelect={() => onSelect({ branch, createNew: false })}
              >
                <GitBranch className="text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{branch}</span>
                {branch === selection.branch && !selection.createNew && (
                  <span className="text-xs text-muted-foreground">Selected</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setCreating(true);
              }}
            >
              <GitBranch className="text-muted-foreground" />
              New branch…
            </DropdownMenuItem>
          </>
        ) : (
          <div
            className="space-y-2 p-2"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <label className="block text-xs font-medium text-foreground">
              New branch
            </label>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canConfirm) {
                  event.preventDefault();
                  onSelect({ branch: trimmed, createNew: true });
                  setOpen(false);
                }
              }}
              placeholder="feature/my-branch"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {validation && (
              <p className="text-xs text-destructive">{validation}</p>
            )}
            <div className="flex justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canConfirm}
                onClick={() => {
                  onSelect({ branch: trimmed, createNew: true });
                  setOpen(false);
                }}
              >
                Create
              </Button>
            </div>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `binary` names the agent this thread will actually launch — hardcoding
 *  "claude" here told a Grok or Codex user the wrong thing. */
function EmptyState({ status, binary }: { status: string; binary: string }) {
  return (
    <div className="mt-16 flex flex-col items-center gap-2 text-center text-muted-foreground">
      <Sparkles className="size-6 opacity-50" />
      <p className="text-sm font-medium text-foreground">Chat with a coding agent</p>
      <p className="max-w-sm text-xs">
        Drives <code className="rounded bg-muted px-1 py-px font-mono text-[11px]">{binary}</code>{" "}
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

/** A transcript item, wrapped in a measurable spine anchor when it is a user
 *  prompt or tool call. User anchors are navigable turn marks; tool anchors
 *  place activity segments at the tool row's real transcript position.
 *  `caps` is the pane's active capability descriptor (US-010) — reasoning
 *  visibility and the turn footer's cost-vs-tokens shape read from it, never
 *  from a provider name. */
function Anchored({
  item,
  planCtx,
  caps,
}: {
  item: ChatItem;
  planCtx?: PlanCtx;
  caps: AgentCapabilities;
}) {
  if (item.role !== "user" && item.role !== "tool")
    return <Item item={item} planCtx={planCtx} caps={caps} />;
  return (
    <div
      data-turn={item.role === "user" ? item.id : undefined}
      data-spine-anchor={item.id}
      className="scroll-mt-4"
    >
      <Item item={item} planCtx={planCtx} caps={caps} />
    </div>
  );
}

/** Renders a transcript list with consecutive tool runs folded into Work Log
 *  groups (roll-ups). `liveActive` marks the LAST group as the one currently
 *  streaming, so it renders expanded while the rest collapse. */
function GroupedTranscript({
  items,
  liveActive,
  planCtx,
  caps,
}: {
  items: ChatItem[];
  liveActive: boolean;
  planCtx?: PlanCtx;
  caps: AgentCapabilities;
}) {
  const chunks = useMemo(() => chunkTranscript(items), [items]);
  const last = chunks[chunks.length - 1];
  const activeGroupId =
    liveActive && last?.kind === "group" ? last.id : null;
  return (
    <>
      {chunks.map((chunk) =>
        chunk.kind === "single" ? (
          <Anchored
            key={chunk.item.id}
            item={chunk.item}
            planCtx={planCtx}
            caps={caps}
          />
        ) : (
          <WorkLogGroup
            key={chunk.id}
            tools={chunk.tools}
            active={chunk.id === activeGroupId}
            planCtx={planCtx}
            caps={caps}
          />
        ),
      )}
    </>
  );
}

/** One collapsed run of tool cards. Expanded shows every card + "Show fewer";
 *  collapsed shows a "+N earlier steps" disclosure above the latest card.
 *  Default follows `active` (the streaming group is open, finished groups
 *  collapse) until the user toggles, which pins the choice. */
function WorkLogGroup({
  tools,
  active,
  planCtx,
  caps,
}: {
  tools: ToolItem[];
  active: boolean;
  planCtx?: PlanCtx;
  caps: AgentCapabilities;
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? active;
  const hidden = tools.length - 1;
  const latest = tools[tools.length - 1];
  const toggle =
    "flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (expanded) {
    return (
      <div className="flex flex-col gap-4">
        {tools.map((t) => (
          <Anchored key={t.id} item={t} planCtx={planCtx} caps={caps} />
        ))}
        <button type="button" onClick={() => setManual(false)} className={toggle}>
          <ChevronUp className="size-3 shrink-0" />
          Show fewer
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => setManual(true)} className={toggle}>
        <ChevronDown className="size-3 shrink-0" />
        {hidden} earlier {hidden === 1 ? "step" : "steps"}
      </button>
      {latest && (
        <Anchored key={latest.id} item={latest} planCtx={planCtx} caps={caps} />
      )}
    </div>
  );
}

/** Compact token count for the turn footer — full precision would crowd the
 *  one-line footer at codex's cache sizes (tens of thousands). */
function fmtTokens(n: number): string {
  // Millions collapse to M (1_000_000 → "1M", not "1000.0k"); ≥10k to k; a
  // whole value drops its ".0" (200_000 → "200k").
  const compact = (v: number, suffix: string) =>
    `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${suffix}`;
  if (n >= 1_000_000) return compact(n / 1_000_000, "M");
  if (n >= 10_000) return compact(n / 1000, "k");
  return n.toLocaleString();
}

/**
 * Composer context-window meter (T3-5). Shows how much of the window the
 * conversation is carrying — the question "why did it get dumber?" had no
 * answer in the UI before this.
 *
 * Honesty rules, in order:
 *   - No position reported yet (fresh thread, or a provider that reports no
 *     usage) → render NOTHING. A zeroed meter would imply an empty window we
 *     haven't actually measured.
 *   - Position known but the window size is null → show the raw count with NO
 *     percentage and no bar. Codex hits this for real: it has no model picker
 *     and reports no model, so we genuinely cannot know which model's window
 *     applies, and inventing a denominator would be a lie.
 *   - Both known → count, percentage, and a bar that warns as it fills.
 */
function ContextMeter({
  used,
  windowTokens,
}: {
  used: number | null;
  windowTokens: number | null;
}) {
  if (used == null) return null;
  const pct = windowTokens ? Math.min(100, (used / windowTokens) * 100) : null;
  // Ring colour by fill; a genuinely-unknown window (codex) is neutral, never
  // a fabricated fill.
  const variant =
    pct == null ? "neutral" : pct >= 90 ? "error" : pct >= 75 ? "warning" : "default";
  const barColor =
    pct == null ? "bg-muted" : pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-amber-500" : "bg-chart-1";

  return (
    <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-7 cursor-default items-center justify-center">
          <ProgressCircle
            value={pct ?? 0}
            radius={11}
            strokeWidth={2.5}
            variant={variant}
          />
        </span>
      </TooltipTrigger>
      {/* Override the default inverted-pill tooltip (bg-foreground/text-background)
          with the app's popover surface so this rich card reads correctly in
          BOTH themes — the inner text/bar tokens assume a popover background. */}
      <TooltipContent
        side="top"
        className="w-60 border border-border bg-popover p-3 text-popover-foreground shadow-md"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-foreground">Context window</span>
          <span className="text-[11px] text-muted-foreground">
            {pct != null
              ? `${Math.round(pct)}% · ${fmtTokens(used)}/${fmtTokens(windowTokens as number)}`
              : `${fmtTokens(used)} tokens`}
          </span>
        </div>
        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full", barColor)}
            style={{ width: pct != null ? `${Math.max(2, pct)}%` : "100%", opacity: pct != null ? 1 : 0.4 }}
          />
        </span>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {pct != null
            ? "Tokens the conversation is carrying (input + cached). Grows each turn."
            : "This provider reports no context-window size, so no percentage is shown — only the raw count."}
        </p>
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
}

/** A file staged to attach to the next turn. */
interface PendingPin {
  path: string;
  content: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  keep?: boolean;
}

/** Compact byte size for pin chips. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pin picker (US-010) — a paperclip that searches the thread's cwd (reusing
 * /api/fs/search) and, on pick, fetches the file's content via /api/fs/read to
 * stage a pin. The browser can't read disk itself; the gateway does the real
 * bounding at turn time.
 */
function PinPicker({
  token,
  cwd,
  onPin,
  disabled,
}: {
  token: string | null;
  cwd: string | null;
  onPin: (pin: PendingPin) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ rel: string; name: string; isDir?: boolean }[]>([]);

  useEffect(() => {
    if (!open || !token || !cwd) return;
    let cancelled = false;
    fetch(
      apiBase() + `/api/fs/search?path=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`,
      { headers: { "x-conan-token": token } },
    )
      .then((r) => (r.ok ? r.json() : { hits: [] }))
      .then((d: { hits?: { rel: string; name: string; isDir?: boolean }[] }) => {
        if (!cancelled) setResults((d.hits ?? []).filter((r) => !r.isDir).slice(0, 8));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, q, token, cwd]);

  const pick = async (path: string) => {
    if (!token) return;
    try {
      const r = await fetch(apiBase() + `/api/fs/read?path=${encodeURIComponent(path)}`, {
        headers: { "x-conan-token": token },
      });
      if (!r.ok) return;
      const d = (await r.json()) as {
        content: string;
        totalBytes: number;
        readBytes: number;
      };
      onPin({
        path,
        content: d.content,
        bytes: d.readBytes,
        totalBytes: d.totalBytes,
        truncated: d.readBytes < d.totalBytes,
      });
    } finally {
      setOpen(false);
      setQ("");
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Add files"
        title="Add a file's content to the next message"
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      >
        <Plus className="size-3.5 shrink-0" />
        Add files
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files to pin…"
          className="mb-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-primary/60"
          onKeyDown={(e) => e.stopPropagation()}
        />
        {results.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">No files</div>
        ) : (
          results.map((r) => (
            <DropdownMenuItem
              key={r.rel}
              onSelect={() => void pick(cwd ? `${cwd}/${r.rel}` : r.rel)}
            >
              <Paperclip className="size-3.5 text-muted-foreground" />
              <span className="truncate">{r.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Render one transcript item by role. */
function Item({
  item,
  planCtx,
  caps,
}: {
  item: ChatItem;
  planCtx?: PlanCtx;
  caps: AgentCapabilities;
}) {
  switch (item.role) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-base text-primary-foreground dark:border dark:border-border dark:bg-card dark:text-card-foreground dark:shadow-sm">
            {item.text}
          </div>
          {/* Images sent with this turn — so the transcript shows what the
              agent actually received. */}
          {item.images && item.images.length > 0 && (
            <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  src={img.dataUrl}
                  alt="sent"
                  className="size-24 rounded-md border border-border object-cover"
                />
              ))}
            </div>
          )}
          {/* Pins sent with this turn (US-010) — show WHAT was included so the
              transcript never misrepresents the prompt. `truncated` is marked
              honestly; the content itself lives in the prompt the agent got. */}
          {item.pins?.map((pin) => (
            <span
              key={pin.path}
              title={pin.path}
              className="inline-flex max-w-[85%] items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate">{basename(pin.path)}</span>
              <span className="shrink-0 opacity-70">
                {fmtBytes(pin.bytes)}
                {pin.truncated ? " · truncated" : ""}
              </span>
            </span>
          ))}
        </div>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "reasoning":
      // The collapsed reasoning UI renders only where the provider delivers
      // READABLE thought text (grok). Claude redacts thinking headlessly
      // (D2 — empty text, signature only), so its reasoning rows stay
      // hidden rather than rendering as empty "Thinking" stubs (US-010).
      return caps.reasoningText ? <ReasoningEntry text={item.text} /> : null;
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
      const ModeIcon = modeIcon(item.mode);
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ModeIcon className="size-3 shrink-0" />
          <span>Permission mode → {MODE_META[item.mode]?.label ?? item.mode}</span>
        </div>
      );
    }
    case "result":
      return (
        <div className="flex items-center gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <span>Turn complete</span>
          {/* Cost vs tokens reads from the capability descriptor (US-010):
              a provider that reports no USD (codex) shows its real token
              counts instead of a blank where the dollar figure would be. */}
          {caps.costUsd && item.costUsd != null && <span>· ${item.costUsd.toFixed(4)}</span>}
          {!caps.costUsd && item.tokens && (
            <span className="tabular-nums">
              {item.tokens.input != null && `· ${fmtTokens(item.tokens.input)} in `}
              {item.tokens.output != null && `· ${fmtTokens(item.tokens.output)} out`}
            </span>
          )}
          {item.durationMs != null && <span>· {(item.durationMs / 1000).toFixed(1)}s</span>}
          {item.numTurns != null && <span>· {item.numTurns} steps</span>}
        </div>
      );
    case "error":
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
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
        "min-w-0 text-base leading-relaxed text-foreground",
        "[&_p]:my-1.5 first:[&_p]:mt-0 last:[&_p]:mb-0",
        "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
        "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-lg [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold",
        "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-medium",
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
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Input
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                {inputStr}
              </pre>
            </div>
          )}
          {item.result != null && (
            <div className="border-t border-border/60 pt-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
