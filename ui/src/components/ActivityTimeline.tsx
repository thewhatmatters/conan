import { useState } from "react";
import type { TimelineEvent } from "../hooks/useSessionEvents.ts";
import type { SubagentNode } from "../hooks/useSubagents.ts";
import type { TranscriptBlock, TranscriptMessage } from "../hooks/useTranscript.ts";

/** Operator choice for a tool-permission prompt (US-012). */
export type PermissionChoice = "allow" | "deny";

interface ActivityTimelineProps {
  events: TimelineEvent[];
  /** Send an approve/deny decision for a prompt to the gateway (US-012). */
  onDecide?: (requestId: string | null, choice: PermissionChoice) => void;
  /**
   * Subagent tree reconstructed from disk for the selected session (US-035).
   * When present (and non-empty) it is the authoritative view: each spawned
   * subagent renders as a node carrying its own per-subagent transcript, nested
   * by the real spawn relationship — works for any session, not just live ones.
   * When empty/absent the timeline falls back to grouping live events by their
   * parent_tool_use_id.
   */
  subagents?: SubagentNode[];
}

/**
 * Live ActivityTimeline for a session (US-011). Renders the lifecycle in order
 * — prompt → PreToolUse (per-tool icon) → PostToolUse result — plus an api_retry
 * badge on retry events and a compaction marker on PreCompact. Fed by
 * useSessionEvents (history + live WS appends). Noisy partial-message stream
 * deltas are filtered out so the timeline reads as discrete actions.
 *
 * Subagent activity (US-021) is nested: events carrying a parent_tool_use_id are
 * grouped under a collapsible subagent node keyed by that id — placed inline
 * after the parent Task tool-use that spawned them (or standalone at the first
 * child when the parent isn't in view). Each node shows the agent_id and links
 * to its transcript path.
 */
export default function ActivityTimeline({
  events,
  onDecide,
  subagents = [],
}: ActivityTimelineProps) {
  // Locally-recorded decisions (request id or `event-<id>` key → choice) so the
  // control disappears the instant a choice is made, before the WS round-trip.
  const [decided, setDecided] = useState<Record<string, PermissionChoice>>({});
  // Subagent nodes are expanded by default; track the ones the user collapsed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // US-008: scope the timeline to one activity type. "All" shows everything; the
  // option list is derived from the types actually present, so it tracks the
  // live stream and combines with the US-007 session ▾ (events are already
  // session-scoped here). Filtering is re-derived each render, so new matching
  // events still stream in while a filter is active.
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);
  // US-021: sort the timeline by timestamp. Default newest-first ("desc"); the
  // toggle flips to oldest-first. Applied to display order on each render, so
  // live-appended events (which useSessionEvents pushes to the end) land at the
  // correct end for the chosen order, and it composes with the type filter.
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const allEntries = events.filter(isTimelineEntry);

  if (allEntries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No activity yet for this session. Events appear here live as the agent
        works.
      </div>
    );
  }

  // Distinct types present (sorted) for the filter chips, plus the filtered set.
  const types = Array.from(new Set(allEntries.map(categoryOf))).sort();
  const filtered =
    typeFilter === ALL_TYPES
      ? allEntries
      : allEntries.filter((e) => categoryOf(e) === typeFilter);
  // Apply the chosen sort direction (id breaks ties for stable ordering). The
  // nesting walk below consumes this ordered set, so subagent groups attach to
  // whichever copy of their parent tool-use appears first in display order.
  const entries = [...filtered].sort((a, b) =>
    sortDir === "asc" ? a.ts - b.ts || a.id - b.id : b.ts - a.ts || b.id - a.id,
  );

  // A prompt is superseded once a later event cancels/answers its request id.
  const resolvedIds = new Set<string>();
  for (const e of events) {
    if (
      e.stream_type === "control_cancel_request" ||
      e.stream_type === "control_response"
    ) {
      const rid = str(parsePayload(e.payload)?.request_id);
      if (rid) resolvedIds.add(rid);
    }
  }

  const decide = (key: string, requestId: string | null, choice: PermissionChoice) => {
    setDecided((d) => ({ ...d, [key]: choice }));
    onDecide?.(requestId, choice);
  };

  // Render one event row with its permission-control wiring (shared by the
  // top-level timeline and nested subagent children).
  const renderRow = (e: TimelineEvent) => {
    const prompt = permissionPrompt(e);
    const key = prompt?.requestId ?? `event-${e.id}`;
    return (
      <TimelineRow
        key={e.id}
        event={e}
        prompt={prompt}
        decision={decided[key]}
        superseded={Boolean(prompt?.requestId && resolvedIds.has(prompt.requestId))}
        onDecide={(choice) => decide(key, prompt?.requestId ?? null, choice)}
      />
    );
  };

  // Group child events (those with a parent_tool_use_id) under their parent.
  const childrenByParent = new Map<string, TimelineEvent[]>();
  for (const e of entries) {
    const pid = e.parent_tool_use_id;
    if (!pid) continue;
    const arr = childrenByParent.get(pid);
    if (arr) arr.push(e);
    else childrenByParent.set(pid, [e]);
  }

  // The set of tool_use ids spawned by a top-level event, so we know which child
  // groups have a visible parent (nested inline) vs. which are orphans.
  const topLevelToolUseIds = new Set<string>();
  for (const e of entries) {
    if (e.parent_tool_use_id) continue;
    const tid = toolUseId(e);
    if (tid) topLevelToolUseIds.add(tid);
  }

  const renderSubagent = (parentId: string, kids: TimelineEvent[]) => {
    const info = subagentInfo(kids);
    return (
      <SubagentGroup
        key={`sub-${parentId}`}
        info={info}
        ts={kids[0]?.ts ?? Date.now()}
        count={kids.length}
        collapsed={collapsed[parentId] ?? false}
        onToggle={() =>
          setCollapsed((c) => ({ ...c, [parentId]: !(c[parentId] ?? false) }))
        }
      >
        {kids.map(renderRow)}
      </SubagentGroup>
    );
  };

  // US-035: disk-reconstructed subagent roots, keyed by the parent Task tool_use
  // id that spawned each. When the session has on-disk subagents (US-014) this
  // tree is authoritative — it shows each subagent's own transcript and real
  // nesting, for any session, not just live ones. Roots whose spawn id is null
  // or whose spawning event isn't in the current view are appended as orphans
  // after the walk so nothing is dropped.
  const hasDisk = subagents.length > 0;
  const diskRootByToolUseId = new Map<string, SubagentNode>();
  for (const r of subagents) {
    if (r.toolUseId && !diskRootByToolUseId.has(r.toolUseId)) {
      diskRootByToolUseId.set(r.toolUseId, r);
    }
  }
  const toggleKey = (key: string) =>
    setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));
  const renderDiskSubagent = (node: SubagentNode) => (
    <DiskSubagentGroup
      key={`disk-${node.agentId}`}
      node={node}
      collapsed={collapsed}
      onToggle={toggleKey}
    />
  );

  // Walk events in order: render top-level rows, nesting each subagent group
  // right after the parent that spawned it. With disk data the reconstructed
  // node (its transcript + children) is rendered; otherwise the live
  // parent_tool_use_id grouping is used, and an orphaned group (parent not
  // shown) renders at the position of its first child. Each group renders once.
  const rendered = new Set<string>();
  const renderedDisk = new Set<string>();
  const nodes: React.ReactNode[] = [];
  for (const e of entries) {
    if (!e.parent_tool_use_id) {
      nodes.push(renderRow(e));
      const tid = toolUseId(e);
      if (!tid) continue;
      const diskRoot = diskRootByToolUseId.get(tid);
      if (diskRoot && !renderedDisk.has(diskRoot.agentId)) {
        renderedDisk.add(diskRoot.agentId);
        nodes.push(renderDiskSubagent(diskRoot));
      } else if (!hasDisk && childrenByParent.has(tid) && !rendered.has(tid)) {
        rendered.add(tid);
        nodes.push(renderSubagent(tid, childrenByParent.get(tid)!));
      }
    } else if (!hasDisk) {
      // Live child event: nest the orphan group when its parent isn't shown.
      // With disk data present the reconstructed transcript is authoritative,
      // so live child rows are subsumed by the disk node above.
      const pid = e.parent_tool_use_id;
      if (!topLevelToolUseIds.has(pid) && !rendered.has(pid)) {
        rendered.add(pid);
        nodes.push(renderSubagent(pid, childrenByParent.get(pid)!));
      }
    }
  }
  // Append any disk roots not anchored to a visible spawn event (orphans).
  if (hasDisk) {
    for (const r of subagents) {
      if (!renderedDisk.has(r.agentId)) {
        renderedDisk.add(r.agentId);
        nodes.push(renderDiskSubagent(r));
      }
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TypeFilter types={types} value={typeFilter} onChange={setTypeFilter} />
        <SortToggle value={sortDir} onChange={setSortDir} />
      </div>
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No <span className="font-medium text-foreground">{typeFilter}</span>{" "}
          events for this session.
        </div>
      ) : (
        <ol className="relative space-y-1">
          {/* the vertical rail */}
          <span
            aria-hidden
            className="absolute left-[15px] top-2 bottom-2 w-px bg-border"
          />
          {nodes}
        </ol>
      )}
    </div>
  );
}

/** Sentinel filter value: show every activity type (US-008). */
const ALL_TYPES = "All";

/**
 * The filter category an event belongs to (US-008): the tool name for
 * tool-bearing events, otherwise a human label for the lifecycle/stream type.
 * Kept in sync with describe() so chips read the way rows do.
 */
function categoryOf(e: TimelineEvent): string {
  if (e.tool_name) return e.tool_name;
  if (e.stream_type === "system/api_retry") return "API retry";
  if (e.stream_type === "control_request:can_use_tool") return "Permission";
  switch (e.hook_event_name) {
    case "UserPromptSubmit":
      return "Prompt";
    case "Notification":
      return "Notification";
    case "PreCompact":
      return "Compaction";
    case "SessionStart":
    case "SessionEnd":
    case "Stop":
      return "Session";
    case "SubagentStart":
    case "SubagentStop":
      return "Subagent";
    default:
      return e.hook_event_name ?? "Other";
  }
}

/**
 * Activity-type filter chips (US-008): "All" plus every type present in the
 * current (session-scoped) event set. The active chip is highlighted.
 */
function TypeFilter({
  types,
  value,
  onChange,
}: {
  types: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[ALL_TYPES, ...types].map((t) => {
        const active = value === t;
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            aria-pressed={active}
            className={
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
              (active
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-muted")
            }
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

/** Timeline sort direction by timestamp (US-021). */
export type SortDir = "asc" | "desc";

/**
 * Newest/oldest-first sort toggle (US-021). A single button that flips the
 * order and labels the current choice; an arrow glyph rotates to match.
 */
function SortToggle({
  value,
  onChange,
}: {
  value: SortDir;
  onChange: (v: SortDir) => void;
}) {
  const newest = value === "desc";
  return (
    <button
      onClick={() => onChange(newest ? "asc" : "desc")}
      aria-label={`Sort by time, ${newest ? "newest" : "oldest"} first`}
      title={`Sorted ${newest ? "newest" : "oldest"} first — click to flip`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
    >
      <span className={newest ? "" : "rotate-180"}>
        <Glyph name="arrowDown" size={13} />
      </span>
      {newest ? "Newest first" : "Oldest first"}
    </button>
  );
}

/** Resolved presentation data for a subagent node (US-021). */
interface SubagentInfo {
  agentId?: string;
  transcriptPath?: string;
  label: string;
}

/**
 * Derive a subagent node's identity from its child events: agent_id and
 * transcript_path (carried on the SubagentStart/Stop and tool hook payloads),
 * plus a label from the Task subagent_type when present.
 */
function subagentInfo(kids: TimelineEvent[]): SubagentInfo {
  let agentId: string | undefined;
  let transcriptPath: string | undefined;
  let subagentType: string | undefined;
  for (const e of kids) {
    const p = parsePayload(e.payload);
    if (!p) continue;
    if (!agentId) agentId = str(p.agent_id) ?? str(p.agentId);
    if (!transcriptPath && typeof p.transcript_path === "string") {
      transcriptPath = p.transcript_path;
    }
    if (!subagentType) {
      subagentType = str(p.subagent_type) ?? str(p.agent_type);
    }
  }
  return {
    agentId,
    transcriptPath,
    label: subagentType ? `Subagent · ${subagentType}` : "Subagent",
  };
}

/**
 * A collapsible subagent node (US-021): a header carrying the agent_id and a
 * link to its transcript path, plus an indented, rail-connected list of the
 * subagent's own events. Collapsed by toggle; expanded by default.
 */
function SubagentGroup({
  info,
  ts,
  count,
  collapsed,
  onToggle,
  children,
}: {
  info: SubagentInfo;
  ts: number;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <li className="relative">
      <div className="flex items-start gap-3 py-1.5">
        <span className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-background text-primary before:absolute before:inset-0 before:-z-10 before:rounded-full before:bg-primary/10">
          <Glyph name="bot" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              onClick={onToggle}
              aria-expanded={!collapsed}
              className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-primary"
            >
              <Glyph name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
              {info.label}
            </button>
            {info.agentId && (
              <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {info.agentId}
              </span>
            )}
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {count} {count === 1 ? "event" : "events"}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">
              {fmtTime(ts)}
            </span>
          </div>
          {info.transcriptPath && (
            <a
              href={`file://${info.transcriptPath}`}
              title={info.transcriptPath}
              className="mt-0.5 inline-flex items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
            >
              <Glyph name="file" size={12} />
              {basename(info.transcriptPath)}
            </a>
          )}
        </div>
      </div>
      {!collapsed && (
        <ol className="relative ml-4 space-y-1 border-l border-dashed border-border pl-4">
          {children}
        </ol>
      )}
    </li>
  );
}

/**
 * A disk-reconstructed subagent node (US-035): the same collapsible visual as a
 * live subagent group, but its body is the subagent's own transcript (read from
 * agent-<id>.jsonl) plus any subagents it spawned, nested recursively. Works for
 * past/observed sessions Conan never launched. Collapse state is shared via the
 * timeline's `collapsed` map, keyed `disk-<agentId>`.
 */
function DiskSubagentGroup({
  node,
  collapsed,
  onToggle,
}: {
  node: SubagentNode;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const key = `disk-${node.agentId}`;
  const isCollapsed = collapsed[key] ?? false;
  const ts = node.transcript.find((m) => m.ts != null)?.ts ?? null;
  const label = node.agentType ? `Subagent · ${node.agentType}` : "Subagent";
  const count = node.transcript.length;
  return (
    <li className="relative">
      <div className="flex items-start gap-3 py-1.5">
        <span className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-background text-primary before:absolute before:inset-0 before:-z-10 before:rounded-full before:bg-primary/10">
          <Glyph name="bot" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              onClick={() => onToggle(key)}
              aria-expanded={!isCollapsed}
              className="inline-flex items-center gap-1 text-sm font-medium text-foreground hover:text-primary"
            >
              <Glyph name={isCollapsed ? "chevronRight" : "chevronDown"} size={14} />
              {label}
            </button>
            <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {node.agentId}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {count} {count === 1 ? "message" : "messages"}
            </span>
            {ts != null && (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {fmtTime(ts)}
              </span>
            )}
          </div>
          {node.description && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {node.description}
            </div>
          )}
        </div>
      </div>
      {!isCollapsed && (
        <ol className="relative ml-4 space-y-2 border-l border-dashed border-border pl-4">
          {node.transcript.length === 0 ? (
            <li className="py-1 text-xs text-muted-foreground">
              No transcript recorded for this subagent.
            </li>
          ) : (
            node.transcript.map((m, i) => (
              <MiniMessage key={m.uuid ?? i} message={m} />
            ))
          )}
          {node.children.map((child) => (
            <DiskSubagentGroup
              key={`disk-${child.agentId}`}
              node={child}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Compact transcript message inside a disk subagent node (US-035). */
function MiniMessage({ message }: { message: TranscriptMessage }) {
  const meta = miniRoleMeta(message.role);
  return (
    <li className="rounded-md border border-border bg-card/60 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span
          className={
            "rounded px-1.5 py-0.5 text-[10px] font-medium " + meta.badge
          }
        >
          {meta.label}
        </span>
        {message.ts != null && (
          <time className="font-mono text-[10px] text-muted-foreground">
            {fmtTime(message.ts)}
          </time>
        )}
      </div>
      <div className="space-y-1">
        {message.blocks.map((b, i) => (
          <MiniBlock key={i} block={b} />
        ))}
      </div>
    </li>
  );
}

function MiniBlock({ block }: { block: TranscriptBlock }) {
  switch (block.type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap text-xs text-foreground">
          {clip(block.text)}
        </p>
      );
    case "thinking":
      return (
        <p className="whitespace-pre-wrap border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {clip(block.text)}
        </p>
      );
    case "tool_use":
      return (
        <div className="font-mono text-xs text-muted-foreground">
          → {block.name}
        </div>
      );
    case "tool_result":
      return (
        <div
          className={
            "font-mono text-xs " +
            (block.isError ? "text-destructive" : "text-muted-foreground")
          }
        >
          {block.isError ? "✗ " : "✓ "}
          {clip(block.text, 200)}
        </div>
      );
    default:
      return null;
  }
}

function miniRoleMeta(role: TranscriptMessage["role"]): {
  label: string;
  badge: string;
} {
  switch (role) {
    case "user":
      return { label: "User", badge: "bg-primary/15 text-primary" };
    case "assistant":
      return { label: "Assistant", badge: "bg-muted text-foreground" };
    case "tool":
      return { label: "Tool result", badge: "bg-muted/60 text-muted-foreground" };
  }
}

/** Collapse whitespace and cap length for a compact transcript line. */
function clip(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * A permission decision point (US-012). Surfaces on the headless control
 * protocol's can_use_tool request and on permission-prompt Notifications.
 * Returns the request id (null when none is carried) or null when the event is
 * not a decision point.
 */
function permissionPrompt(e: TimelineEvent): { requestId: string | null } | null {
  if (e.stream_type === "control_request:can_use_tool") {
    return { requestId: str(parsePayload(e.payload)?.request_id) ?? null };
  }
  if (e.hook_event_name === "Notification") {
    const p = parsePayload(e.payload);
    const msg = (str(p?.message) ?? "").toLowerCase();
    if (msg.includes("permission") || p?.permission_decision || p?.permission_mode) {
      return { requestId: str(p?.request_id) ?? null };
    }
  }
  return null;
}

/** Which events earn a timeline row — lifecycle hooks + api_retry markers. */
function isTimelineEntry(e: TimelineEvent): boolean {
  if (e.hook_event_name) return true;
  if (e.stream_type === "system/api_retry") return true;
  if (e.stream_type === "control_request:can_use_tool") return true;
  return false;
}

interface TimelineRowProps {
  event: TimelineEvent;
  prompt: { requestId: string | null } | null;
  decision?: PermissionChoice;
  superseded: boolean;
  onDecide: (choice: PermissionChoice) => void;
}

function TimelineRow({
  event: e,
  prompt,
  decision,
  superseded,
  onDecide,
}: TimelineRowProps) {
  const meta = describe(e);
  // Show the live control only while the prompt is open: not yet decided and
  // not superseded by a later cancel/response (criterion 3).
  const showControl = Boolean(prompt) && !decision && !superseded;
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
        {prompt && (
          <PermissionControl
            show={showControl}
            decision={decision}
            superseded={superseded}
            onDecide={onDecide}
          />
        )}
      </div>
    </li>
  );
}

/**
 * Inline Approve/Deny control for a permission prompt (US-012). Renders the
 * two buttons while the prompt is open, then collapses to a resolved badge once
 * a decision is made or the prompt is superseded.
 */
function PermissionControl({
  show,
  decision,
  superseded,
  onDecide,
}: {
  show: boolean;
  decision?: PermissionChoice;
  superseded: boolean;
  onDecide: (choice: PermissionChoice) => void;
}) {
  if (show) {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={() => onDecide("allow")}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <Glyph name="check" size={12} /> Approve
        </button>
        <button
          onClick={() => onDecide("deny")}
          className="inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/20"
        >
          <Glyph name="x" size={12} /> Deny
        </button>
        <span className="text-[11px] text-muted-foreground/70">
          Permission requested
        </span>
      </div>
    );
  }
  let label = "Resolved";
  let cls = "border-border bg-muted text-muted-foreground";
  if (decision === "allow") {
    label = "Approved";
    cls = "border-primary/40 bg-primary/10 text-primary";
  } else if (decision === "deny") {
    label = "Denied";
    cls = "border-destructive/40 bg-destructive/10 text-destructive";
  } else if (superseded) {
    label = "Superseded";
  }
  return (
    <div className="mt-1.5">
      <span
        className={
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium " +
          cls
        }
      >
        {decision === "allow" && <Glyph name="check" size={11} />}
        {decision === "deny" && <Glyph name="x" size={11} />}
        {label}
      </span>
    </div>
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
  // Opaque circle backgrounds (US-022): bg-card/bg-background mask the connector
  // rail. Tinted variants keep their colour via a negative-z ::before overlay so
  // the tint sits over the opaque base (above the rail) without letting the rail
  // show through. The icon (in-flow content) still paints above the overlay.
  const neutral = "border-border bg-card text-muted-foreground";
  const primary =
    "border-primary/40 bg-background text-primary before:absolute before:inset-0 before:-z-10 before:rounded-full before:bg-primary/10";
  const danger =
    "border-destructive/40 bg-background text-destructive before:absolute before:inset-0 before:-z-10 before:rounded-full before:bg-destructive/10";

  // can_use_tool permission request from the headless control protocol (US-012).
  if (e.stream_type === "control_request:can_use_tool") {
    return {
      title: e.tool_name ?? "Tool",
      kind: "permission",
      detail: toolDetail(e.tool_name, payload?.input),
      icon: <Glyph name="shield" />,
      dotClass: primary,
    };
  }

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

/**
 * The tool_use id an event represents, if any — the handle a subagent's child
 * events reference via parent_tool_use_id (US-021). Read from a hook's
 * tool_use_id or from a tool_use block in a stream-json message's content.
 */
function toolUseId(e: TimelineEvent): string | null {
  const p = parsePayload(e.payload);
  if (!p) return null;
  if (typeof p.tool_use_id === "string") return p.tool_use_id;
  if (typeof p.toolUseId === "string") return p.toolUseId;
  const blocks = Array.isArray(p.content)
    ? p.content
    : p.content_block
      ? [p.content_block]
      : [];
  for (const b of blocks) {
    if (
      b &&
      typeof b === "object" &&
      (b as Record<string, unknown>).type === "tool_use" &&
      typeof (b as Record<string, unknown>).id === "string"
    ) {
      return (b as Record<string, unknown>).id as string;
    }
  }
  return null;
}

/** Last path segment of a file path, for a compact transcript-link label. */
function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
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
  | "shield"
  | "check"
  | "x"
  | "chevronRight"
  | "chevronDown"
  | "arrowDown"
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
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  chevronRight: <polyline points="9 18 15 12 9 6" />,
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  arrowDown: (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
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
