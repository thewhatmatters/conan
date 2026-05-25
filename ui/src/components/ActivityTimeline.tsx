import type { TimelineEvent } from "../hooks/useSessionEvents.ts";

interface ActivityTimelineProps {
  events: TimelineEvent[];
}

/**
 * Live ActivityTimeline for a session (US-011). Renders the lifecycle in order
 * — prompt → PreToolUse (per-tool icon) → PostToolUse result — plus an api_retry
 * badge on retry events and a compaction marker on PreCompact. Fed by
 * useSessionEvents (history + live WS appends). Noisy partial-message stream
 * deltas are filtered out so the timeline reads as discrete actions.
 */
export default function ActivityTimeline({ events }: ActivityTimelineProps) {
  const entries = events.filter(isTimelineEntry);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No activity yet for this session. Events appear here live as the agent
        works.
      </div>
    );
  }

  return (
    <ol className="relative space-y-1">
      {/* the vertical rail */}
      <span
        aria-hidden
        className="absolute left-[15px] top-2 bottom-2 w-px bg-border"
      />
      {entries.map((e) => (
        <TimelineRow key={e.id} event={e} />
      ))}
    </ol>
  );
}

/** Which events earn a timeline row — lifecycle hooks + api_retry markers. */
function isTimelineEntry(e: TimelineEvent): boolean {
  if (e.hook_event_name) return true;
  if (e.stream_type === "system/api_retry") return true;
  return false;
}

function TimelineRow({ event: e }: { event: TimelineEvent }) {
  const meta = describe(e);
  return (
    <li className="relative flex items-start gap-3 py-1.5 pl-0">
      <span
        className={
          "relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border " +
          meta.dotClass
        }
      >
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">
            {meta.title}
          </span>
          {meta.kind && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {meta.kind}
            </span>
          )}
          {meta.badge}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">
            {fmtTime(e.ts)}
          </span>
        </div>
        {meta.detail && (
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {meta.detail}
          </div>
        )}
      </div>
    </li>
  );
}

interface EntryMeta {
  title: string;
  kind?: string;
  detail?: string;
  icon: React.ReactNode;
  dotClass: string;
  badge?: React.ReactNode;
}

const RetryBadge = (
  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
    <Glyph name="retry" size={11} /> api_retry
  </span>
);

const CompactionBadge = (
  <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
    <Glyph name="archive" size={11} /> compaction
  </span>
);

/** Map an event to its timeline presentation. */
function describe(e: TimelineEvent): EntryMeta {
  const payload = parsePayload(e.payload);
  const neutral = "border-border bg-card text-muted-foreground";
  const primary = "border-primary/40 bg-primary/10 text-primary";
  const danger = "border-destructive/40 bg-destructive/10 text-destructive";

  // api_retry from the stream-json parser.
  if (e.stream_type === "system/api_retry") {
    return {
      title: "API retry",
      detail: str(payload?.message) ?? str(payload?.error),
      icon: <Glyph name="retry" />,
      dotClass: neutral,
      badge: RetryBadge,
    };
  }

  switch (e.hook_event_name) {
    case "UserPromptSubmit":
      return {
        title: "Prompt",
        detail: str(payload?.prompt) ?? str(payload?.user_prompt),
        icon: <Glyph name="prompt" />,
        dotClass: primary,
      };
    case "PreToolUse":
      return {
        title: e.tool_name ?? "Tool",
        kind: "PreToolUse",
        detail: toolDetail(e.tool_name, payload?.tool_input),
        icon: <ToolGlyph tool={e.tool_name} />,
        dotClass: neutral,
      };
    case "PostToolUse":
      return {
        title: e.tool_name ?? "Tool",
        kind: "result",
        detail: toolDetail(e.tool_name, payload?.tool_input),
        icon: <ToolGlyph tool={e.tool_name} />,
        dotClass: neutral,
      };
    case "PostToolUseFailure":
      return {
        title: e.tool_name ?? "Tool",
        kind: "failed",
        detail: str(payload?.error) ?? toolDetail(e.tool_name, payload?.tool_input),
        icon: <ToolGlyph tool={e.tool_name} />,
        dotClass: danger,
      };
    case "Notification":
      return {
        title: "Notification",
        detail: str(payload?.message),
        icon: <Glyph name="bell" />,
        dotClass: neutral,
      };
    case "PreCompact":
      return {
        title: "Compaction",
        detail: str(payload?.trigger) ? `trigger: ${str(payload?.trigger)}` : undefined,
        icon: <Glyph name="archive" />,
        dotClass: primary,
        badge: CompactionBadge,
      };
    case "SessionStart":
      return { title: "Session started", icon: <Glyph name="play" />, dotClass: primary };
    case "SessionEnd":
      return { title: "Session ended", icon: <Glyph name="stop" />, dotClass: neutral };
    case "Stop":
      return { title: "Stopped", icon: <Glyph name="stop" />, dotClass: neutral };
    case "SubagentStart":
      return { title: "Subagent started", icon: <Glyph name="bot" />, dotClass: neutral };
    case "SubagentStop":
      return { title: "Subagent finished", icon: <Glyph name="bot" />, dotClass: neutral };
    default:
      return {
        title: e.hook_event_name ?? e.stream_type ?? "Event",
        icon: <Glyph name="dot" />,
        dotClass: neutral,
      };
  }
}

// --- payload helpers --------------------------------------------------------

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length ? (t.length > 160 ? t.slice(0, 159) + "…" : t) : undefined;
}

/** A compact one-line description of a tool invocation from its input. */
function toolDetail(tool: string | null, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  switch (tool) {
    case "Bash":
      return str(i.command);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str(i.file_path) ?? str(i.notebook_path);
    case "Grep":
      return str(i.pattern);
    case "Glob":
      return str(i.pattern);
    case "WebFetch":
      return str(i.url);
    case "WebSearch":
      return str(i.query);
    case "Task":
      return str(i.description) ?? str(i.subagent_type);
    default: {
      // Fall back to the first short string value in the input.
      for (const v of Object.values(i)) {
        const s = str(v);
        if (s) return s;
      }
      return undefined;
    }
  }
}

// --- icons (Lucide path data, rendered inline to match the conan UI) --------

function ToolGlyph({ tool }: { tool: string | null }) {
  return <Glyph name={toolIconName(tool)} />;
}

function toolIconName(tool: string | null): GlyphName {
  switch (tool) {
    case "Bash":
      return "terminal";
    case "Read":
      return "file";
    case "Write":
      return "filePlus";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "pencil";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "globe";
    case "Task":
      return "bot";
    case "TodoWrite":
      return "listChecks";
    default:
      return "wrench";
  }
}

type GlyphName =
  | "terminal"
  | "file"
  | "filePlus"
  | "pencil"
  | "search"
  | "globe"
  | "bot"
  | "listChecks"
  | "wrench"
  | "prompt"
  | "bell"
  | "archive"
  | "retry"
  | "play"
  | "stop"
  | "dot";

const PATHS: Record<GlyphName, React.ReactNode> = {
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </>
  ),
  filePlus: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M9 15h6" />
      <path d="M12 18v-6" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  listChecks: (
    <>
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  prompt: (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  archive: (
    <>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  retry: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  stop: <rect width="14" height="14" x="5" y="5" rx="2" />,
  dot: <circle cx="12" cy="12" r="4" />,
};

function Glyph({ name, size = 15 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
