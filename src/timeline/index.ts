import { type EventRow } from "../session/index.js";
import { getDb } from "../db/index.js";
import { readTasks, progressMtimeMs } from "../tasks/index.js";

/**
 * Build rows are "actively running"-only: progress.txt activity is included
 * only when the file was written to within this window (no chip on stale
 * trails from past runs). Mirrored client-side in Timeline.tsx (buildCutoff
 * in freshRows) — update both constants in lockstep.
 *
 * 30 min covers a typical run-tasks.sh story iteration, which writes
 * progress.txt only once per iteration — a 60s window made the chip blink
 * out mid-run. A pgrep "runner alive" check was considered and deliberately
 * deferred for v1.0.1; the wider mtime window is the simpler fix.
 */
export const BUILD_ACTIVE_WINDOW_MS = 1_800_000;
import { getActiveCwd } from "../cwd/index.js";
import {
  readSessionSkillFirings,
  readSessionPlans,
  type SkillFiredRecord,
  type PlanRecord,
  type PlanItem,
} from "./transcriptScan.js";
import {
  readAssistantTurnUsages,
  type AssistantTurnUsage,
} from "../transcript/index.js";

// Per-session Timeline (US-001 v4.5): the chronological feed that powers the
// Timeline split panel inside each terminal tab. Source of truth on read is the
// persisted `event` table (hooks) + the build-loop's progress.txt activity
// trail (filtered to the session's project). Live updates arrive separately
// over /ws (existing {type:'event'} + {type:'tasks'} broadcasts); the UI
// backfills from this route on mount.
//
// Skill rows (skill-fired, skill-considered) are part of the envelope contract
// here but populated by US-002 / US-003 — this route returns no skill rows yet.

/** Hook event subtypes the Timeline collapses raw payloads into. */
export type HookSubtype =
  | "PROMPT"
  | "PRETOOL"
  | "POSTTOOL"
  | "STOP"
  | "NOTIF"
  | "SESSION"
  | "EVENT";

/** Build event subtypes derived from a progress.txt activity line. */
export type BuildSubtype = "iteration" | "pass" | "trail";

/** Loop event subtypes — the Claude Code `/loop` skill + its scheduling tools.
 *  Distinct from `kind:"build"`, which surfaces the run-tasks.sh runner trail. */
export type LoopSubtype = "invocation" | "schedule";

/** The Claude Code tools `/loop` uses to self-pace; surfacing them as Loop rows
 *  is how the user sees the iteration cadence rather than just the first prompt. */
const LOOP_SCHEDULING_TOOLS = new Set(["ScheduleWakeup", "CronCreate"]);

/** Discriminated union of every row the Timeline can render. */
export type TimelineRow =
  | {
      kind: "hook";
      ts: number;
      eventId: number;
      subtype: HookSubtype;
      title: string;
      detail?: string;
      payload?: unknown;
      /** Per-turn token total — only set on STOP rows when a matching
       *  assistant `usage` block can be read from the transcript. The
       *  Timeline renders this as a "+12k" badge on the row's right edge. */
      tokens?: number;
    }
  | {
      // The run-tasks.sh runner's progress.txt trail — niche, only meaningful
      // for users running our autonomous prd→json→build workflow. Renamed
      // from `kind:"loop"` (v4.5-timeline) to disambiguate from Claude's own
      // `/loop` skill, which now owns the `loop` kind below.
      kind: "build";
      ts: number;
      subtype: BuildSubtype;
      title: string;
      detail?: string;
    }
  | {
      // Claude Code's `/loop` skill — both the initial invocation (a
      // UserPromptSubmit whose prompt starts with "/loop") and the
      // ScheduleWakeup/CronCreate tool calls the skill uses to self-pace.
      // Detected at map time so these rows don't pollute the Hooks lane.
      kind: "loop";
      ts: number;
      eventId?: number;
      subtype: LoopSubtype;
      title: string;
      detail?: string;
      payload?: unknown;
    }
  | {
      kind: "skill-fired";
      ts: number;
      eventId?: number;
      skill: string;
      promptEventId?: number;
      detail?: string;
    }
  | {
      kind: "skill-considered";
      ts: number;
      eventId?: number;
      skill: string;
      promptEventId?: number;
      reason: string;
      heuristic: true;
    }
  | {
      kind: "plan";
      ts: number;
      subtype: "todo-write" | "plan-mode";
      eventId?: number;
      promptEventId?: number;
      /** TodoWrite items; present only when subtype === 'todo-write'. */
      items?: PlanItem[];
      /** ExitPlanMode plan text; present only when subtype === 'plan-mode'. */
      plan?: string;
    };

/** Hard cap on `limit`; matches what the UI ever asks for in one backfill. */
export const TIMELINE_LIMIT_MAX = 500;
/** Default when the caller omits limit. */
export const TIMELINE_LIMIT_DEFAULT = 200;

/** Parse a payload-stringified column into an object, tolerating malformed JSON. */
function parsePayload(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Trim a freeform string for a one-line title; ellipsises long input. */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * Render a tool_input into a short "first arg" detail string — e.g.
 * Bash → `command`, Read → `file_path`, Grep → `pattern`. We iterate the
 * tool_input keys in insertion order (the same order Claude Code emits them)
 * and pick the first string-valued one whose value isn't empty. Falls back to
 * an empty string when there's nothing useful to render.
 */
function firstStringArg(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const v of Object.values(toolInput as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

/**
 * Map one persisted hook EventRow onto a TimelineRow envelope. Pure (no DB)
 * for unit-testability. Returns null for non-hook events (those have no
 * subtype mapping documented for US-001).
 */
export function mapHookEventToRow(row: EventRow): TimelineRow | null {
  if (row.stream_type !== "hook") return null;
  const payload = parsePayload(row.payload);
  const name = row.hook_event_name ?? "";

  let subtype: HookSubtype = "EVENT";
  let title = name || "event";
  let detail: string | undefined;

  switch (name) {
    case "UserPromptSubmit": {
      const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
      // `/loop <task>` is Claude Code's self-iteration skill — route it to the
      // Loop lane so the Hooks lane doesn't get polluted with what's really
      // about iteration scheduling. The "/loop" prefix is a stable contract.
      if (/^\/loop(?:\s|$)/i.test(prompt)) {
        return {
          kind: "loop",
          ts: row.ts,
          eventId: row.id,
          subtype: "invocation",
          title: truncate(prompt, 160),
          ...(payload ? { payload } : {}),
        };
      }
      subtype = "PROMPT";
      title = prompt ? truncate(prompt, 160) : "(empty prompt)";
      break;
    }
    case "PreToolUse":
    case "PostToolUse": {
      const tool =
        row.tool_name ?? (typeof payload?.tool_name === "string" ? payload.tool_name : "");
      const arg = firstStringArg(payload?.tool_input);
      // ScheduleWakeup / CronCreate are how `/loop` self-paces — surface them
      // as Loop rows so the user sees the cadence, not just the first prompt.
      // Only PreToolUse (one row per scheduling call, not a duplicate Post).
      if (name === "PreToolUse" && LOOP_SCHEDULING_TOOLS.has(tool)) {
        return {
          kind: "loop",
          ts: row.ts,
          eventId: row.id,
          subtype: "schedule",
          title: arg ? `${tool} · ${truncate(arg, 120)}` : tool,
          ...(payload ? { payload } : {}),
        };
      }
      subtype = name === "PreToolUse" ? "PRETOOL" : "POSTTOOL";
      title = arg ? `${tool || "tool"} · ${truncate(arg, 120)}` : tool || "tool";
      break;
    }
    case "Stop": {
      subtype = "STOP";
      title = "turn ended";
      break;
    }
    case "Notification": {
      subtype = "NOTIF";
      const msg = typeof payload?.message === "string" ? payload.message : "";
      title = msg ? truncate(msg, 160) : "notification";
      break;
    }
    case "SessionStart":
    case "SessionEnd": {
      subtype = "SESSION";
      if (name === "SessionStart") {
        const version = typeof payload?.version === "string" ? payload.version : "";
        const source = typeof payload?.source === "string" ? payload.source : "";
        title = "SessionStart";
        const parts: string[] = [];
        if (source) parts.push(source);
        if (version) parts.push(`v${version}`);
        if (parts.length) detail = parts.join(" · ");
      } else {
        title = "SessionEnd";
        const reason = typeof payload?.reason === "string" ? payload.reason : "";
        if (reason) detail = reason;
      }
      break;
    }
    default:
      subtype = "EVENT";
      title = name || "event";
  }

  return {
    kind: "hook",
    ts: row.ts,
    eventId: row.id,
    subtype,
    title,
    ...(detail ? { detail } : {}),
    // Carry the parsed payload so the UI can render expanded detail (tool
    // input, notification body) without re-parsing. Omitted when the payload
    // is malformed; never surfaces a raw string.
    ...(payload ? { payload } : {}),
  };
}

/**
 * Parse the leading timestamp off a progress.txt activity line into epoch ms.
 * progress.txt mixes two human-written formats:
 *   `[2026-05-27 13:46:06] iteration 10 → US-010: …`  (bracketed, w/ seconds)
 *   `2026-05-27 14:20 US-010 done: …`                 (bare, minutes only)
 * Returns null when no leading timestamp can be parsed (the line is dropped).
 */
export function parseActivityTimestamp(line: string): number | null {
  // Strip the surrounding [..] if present, then read a `YYYY-MM-DD HH:MM(:SS)?`
  // prefix off whatever remains.
  const stripped = line.startsWith("[")
    ? line.slice(1, line.indexOf("]") === -1 ? undefined : line.indexOf("]"))
    : line;
  const m = stripped.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m || !m[1] || !m[2]) return null;
  const date = m[1];
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  const ts = Date.parse(`${date}T${time}`);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Strip the leading timestamp (bracketed or bare) off an activity line so the
 * Timeline title doesn't double-render the time the row already carries.
 */
function stripActivityTimestamp(line: string): string {
  if (line.startsWith("[")) {
    const end = line.indexOf("]");
    if (end !== -1) return line.slice(end + 1).trim();
  }
  return line.replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\s*/, "").trim();
}

/**
 * Map one progress.txt activity line onto a TimelineRow. Returns null when the
 * line has no parseable timestamp (we never fabricate a ts). Subtype is
 * inferred from the line's content (US-001 — 'iteration'|'pass'|'trail').
 */
export function mapActivityLineToRow(line: string): TimelineRow | null {
  const ts = parseActivityTimestamp(line);
  if (ts === null) return null;
  const body = stripActivityTimestamp(line);
  if (!body) return null;

  let subtype: BuildSubtype = "trail";
  if (/iteration\s+\d+/i.test(body) || /→\s*US-/.test(body)) subtype = "iteration";
  else if (/\bUS-\d+\b.*\b(?:done|pass(?:es)?)\b/i.test(body) || /passes:\s*true/i.test(body))
    subtype = "pass";

  return {
    kind: "build",
    ts,
    subtype,
    title: truncate(body, 160),
  };
}

/**
 * One persisted prompt_consideration row (US-003), as read by buildTimeline.
 * `ts` is the prompt event's ts so the row sorts naturally next to its PROMPT.
 */
export interface SkillConsideredRecord {
  promptEventId: number;
  skill: string;
  reason: string;
  ts: number;
}

/** Options accepted by the Timeline route's pure-function core. */
export interface BuildTimelineOpts {
  events: EventRow[];
  activity: string[];
  /**
   * Transcript-derived Skill firings (US-002). Empty when the JSONL is missing
   * or carries no Skill blocks. promptEventId is resolved here against the
   * mapped PROMPT rows — never fabricated.
   */
  skillsFired?: SkillFiredRecord[];
  /**
   * Persisted skill-consideration rows (US-003) for this session. Only
   * non-fired rows are passed (the SQL filters with WHERE fired=0); this layer
   * additionally dedupes against `skillsFired` so a row that fired live but
   * hasn't been DB-reconciled yet still doesn't double-render.
   */
  skillsConsidered?: SkillConsideredRecord[];
  /**
   * Transcript-derived Plan records (US-006): TodoWrite + ExitPlanMode tool_use
   * blocks pulled from the same JSONL the skill firings come from. Empty when
   * the session has no plan blocks (or no JSONL). promptEventId is resolved
   * here against the mapped PROMPT rows — never fabricated.
   */
  plans?: PlanRecord[];
  /** The session's cwd, from the session row. Used to gate loop rows. */
  sessionCwd: string | null;
  /** The cwd progress.txt itself is read from (the build-loop's project). */
  activeCwd: string;
  /**
   * Per-assistant-turn token totals (post-loop polish) — one entry per
   * assistant message with a `usage` block, ascending by ts. Each STOP hook
   * row is matched to the latest entry with `ts <= row.ts` and gets a
   * `tokens` field so the UI can render a "+12k" badge. Omitted when there's
   * no transcript or the JSONL has no usage blocks.
   */
  assistantUsages?: AssistantTurnUsage[];
  /** Strict-greater-than ts filter (epoch ms). */
  since?: number;
  /** Clamped to [1, TIMELINE_LIMIT_MAX]. Default TIMELINE_LIMIT_DEFAULT. */
  limit?: number;
}

/**
 * Latest prompt-event id whose ts is strictly less than `ts`, given an
 * ascending-by-ts `promptIds` list. Linear scan from the end — the prompt list
 * is small (one row per turn) so this is fine without a true binary search.
 */
function latestPromptIdBefore(
  promptIds: { ts: number; id: number }[],
  ts: number,
): number | null {
  for (let i = promptIds.length - 1; i >= 0; i--) {
    const entry = promptIds[i];
    if (entry && entry.ts < ts) return entry.id;
  }
  return null;
}

/** Clamp `limit` to [1, TIMELINE_LIMIT_MAX], defaulting when missing/invalid. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TIMELINE_LIMIT_DEFAULT;
  return Math.min(TIMELINE_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * Pure core of the Timeline read path: merge mapped hook rows and (when the
 * session's cwd matches the active cwd that owns progress.txt) loop rows,
 * apply `since`/`limit`, and return descending-by-ts. No DB, no fs — every
 * input is injected.
 */
export function buildTimeline(opts: BuildTimelineOpts): TimelineRow[] {
  const limit = clampLimit(opts.limit);
  const since = opts.since;

  const hookRows: TimelineRow[] = [];
  // Track prompt-event id by ts so skill-fired rows can be linked to the
  // prompt that triggered them. The map is ts → latest-PROMPT-event-id so a
  // subsequent skill firing finds the correct turn boundary.
  const promptIds: { ts: number; id: number }[] = [];
  for (const ev of opts.events) {
    const row = mapHookEventToRow(ev);
    if (!row) continue;
    if (row.kind === "hook" && row.subtype === "PROMPT") {
      promptIds.push({ ts: row.ts, id: row.eventId });
    }
    if (since === undefined || row.ts > since) hookRows.push(row);
  }
  // Per-turn token-burn badges (post-loop polish): walk STOP rows and attach
  // the assistant turn's total token usage. Each STOP fires after the
  // matching assistant message lands in the JSONL, so the right entry is the
  // latest `assistantUsages` row whose ts <= the STOP row's ts. The usages
  // array is ascending by ts (small N — one per turn — so a tail-scan beats a
  // binary search in practice).
  const usages = opts.assistantUsages ?? [];
  if (usages.length > 0) {
    for (const row of hookRows) {
      if (row.kind !== "hook" || row.subtype !== "STOP") continue;
      let tokens: number | null = null;
      for (let i = usages.length - 1; i >= 0; i--) {
        const u = usages[i];
        if (u && u.ts <= row.ts) {
          tokens = u.totalTokens;
          break;
        }
      }
      if (tokens != null) row.tokens = tokens;
    }
  }
  // Ascending ts so the "latest PROMPT before X" lookup is a binary-friendly walk.
  promptIds.sort((a, b) => a.ts - b.ts);

  const loopRows: TimelineRow[] = [];
  // Loop rows only belong on the timeline when the session's cwd matches the
  // project progress.txt was written for. progress.txt has no session id.
  if (opts.sessionCwd && opts.sessionCwd === opts.activeCwd) {
    for (const line of opts.activity) {
      const row = mapActivityLineToRow(line);
      if (row && (since === undefined || row.ts > since)) loopRows.push(row);
    }
  }

  // Transcript-derived Skill firings (US-002). Each record carries the skill
  // name + ts; we resolve the prompt that triggered it as the latest
  // UserPromptSubmit event id whose ts < skill.ts (never fabricated — omitted
  // when no preceding prompt exists, e.g. a build-loop session firing skills
  // before any user prompt).
  const skillRows: TimelineRow[] = [];
  // Track (promptEventId, skill) pairs that have already fired so the US-003
  // considered rows can't double-render alongside their own fired counterpart
  // when the DB hasn't been Stop-reconciled yet (race between live skill-fired
  // and Stop). The DB-side WHERE fired=0 already excludes reconciled rows; this
  // is the in-memory safety net for the unreconciled gap.
  const firedPairs = new Set<string>();
  for (const record of opts.skillsFired ?? []) {
    const promptEventId = latestPromptIdBefore(promptIds, record.ts);
    if (promptEventId !== null) {
      firedPairs.add(`${promptEventId}|${record.skill}`);
    }
    if (since !== undefined && record.ts <= since) continue;
    skillRows.push({
      kind: "skill-fired",
      ts: record.ts,
      skill: record.skill,
      ...(promptEventId !== null ? { promptEventId } : {}),
      detail: `Skill: ${record.skill}`,
    });
  }

  // US-003: skill-considered rows from prompt_consideration (fired=0 only).
  // ts is the prompt's ts so the row sorts next to its PROMPT in the feed.
  for (const considered of opts.skillsConsidered ?? []) {
    if (since !== undefined && considered.ts <= since) continue;
    if (firedPairs.has(`${considered.promptEventId}|${considered.skill}`)) continue;
    skillRows.push({
      kind: "skill-considered",
      ts: considered.ts,
      eventId: considered.promptEventId,
      skill: considered.skill,
      promptEventId: considered.promptEventId,
      reason: considered.reason,
      heuristic: true,
    });
  }

  // US-006 (v4.5): transcript-derived Plan rows (TodoWrite + ExitPlanMode).
  // promptEventId is the latest UserPromptSubmit event_id before the block's
  // ts (same resolution as skill firings). eventId mirrors promptEventId so the
  // UI can scope rows to their prompt the same way the skill-considered path
  // does. Honest by construction — omitted when no preceding prompt exists.
  const planRows: TimelineRow[] = [];
  for (const record of opts.plans ?? []) {
    if (since !== undefined && record.ts <= since) continue;
    const promptEventId = latestPromptIdBefore(promptIds, record.ts);
    const idFields =
      promptEventId !== null ? { eventId: promptEventId, promptEventId } : {};
    if (record.subtype === "todo-write") {
      planRows.push({
        kind: "plan",
        ts: record.ts,
        subtype: "todo-write",
        ...idFields,
        items: record.items,
      });
    } else {
      planRows.push({
        kind: "plan",
        ts: record.ts,
        subtype: "plan-mode",
        ...idFields,
        plan: record.plan,
      });
    }
  }

  const all = [...hookRows, ...loopRows, ...skillRows, ...planRows];
  // Descending by ts. Stable secondary key (hook event id) keeps two events at
  // the exact same epoch-ms in their persisted order — Stop after PostToolUse.
  all.sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    const aId = a.kind === "hook" ? a.eventId : 0;
    const bId = b.kind === "hook" ? b.eventId : 0;
    return bId - aId;
  });
  return all.slice(0, limit);
}

/** Look up a session row's cwd; null when the session is unknown. */
function sessionCwd(sessionId: string): string | null {
  const row = getDb()
    .prepare("SELECT cwd FROM session WHERE id = ?")
    .get(sessionId) as { cwd: string | null } | undefined;
  return row?.cwd ?? null;
}

/**
 * Fetch the most-recent hook events for a session, optionally past `since`.
 * Uses DESC + LIMIT in SQL so the timeline read never scans the oldest rows.
 */
function listRecentHookEvents(
  sessionId: string,
  since: number | undefined,
  limit: number,
): EventRow[] {
  const params: unknown[] = [sessionId];
  let sql = `SELECT id, session_id, parent_tool_use_id, hook_event_name,
                    stream_type, tool_name, payload, ts
               FROM event
               WHERE session_id = ? AND stream_type = 'hook'`;
  if (typeof since === "number" && Number.isFinite(since)) {
    sql += " AND ts > ?";
    params.push(since);
  }
  sql += " ORDER BY ts DESC, id DESC LIMIT ?";
  params.push(limit);
  return getDb().prepare(sql).all(...params) as EventRow[];
}

/**
 * Persisted skill-consideration rows for a session (US-003). Joins
 * prompt_consideration to event to scope by session_id and pick up the
 * prompt's ts. Only non-fired rows are returned — fired ones come through the
 * US-002 transcript-derived skill-fired path. Bounded by TIMELINE_LIMIT_MAX so
 * the join never returns more than a sane page.
 */
function listSkillConsideredFor(sessionId: string): SkillConsideredRecord[] {
  return getDb()
    .prepare(
      `SELECT pc.event_id AS promptEventId,
              pc.skill    AS skill,
              pc.reason   AS reason,
              e.ts        AS ts
         FROM prompt_consideration pc
         JOIN event e ON e.id = pc.event_id
        WHERE e.session_id = ?
          AND pc.fired = 0
        ORDER BY e.ts DESC, pc.skill ASC
        LIMIT ?`,
    )
    .all(sessionId, TIMELINE_LIMIT_MAX) as SkillConsideredRecord[];
}

/**
 * Public read entrypoint backing GET /api/claude/timeline. Returns [] for an
 * unknown/missing session, never throws.
 */
export function readTimeline(
  sessionId: string | null,
  opts: { since?: number; limit?: number } = {},
): TimelineRow[] {
  if (!sessionId) return [];
  const cwd = sessionCwd(sessionId);
  if (cwd === null) return [];
  const limit = clampLimit(opts.limit);
  const events = listRecentHookEvents(sessionId, opts.since, TIMELINE_LIMIT_MAX);
  const tasks = readTasks();
  // v4.5-timeline polish: Build rows are gated to a "currently running" window
  // — pass an empty activity list when progress.txt hasn't been written to in
  // the last BUILD_ACTIVE_WINDOW_MS so a stale trail doesn't surface a Build
  // chip after the runner has stopped.
  const mtime = progressMtimeMs();
  const activeActivity =
    mtime !== null && Date.now() - mtime < BUILD_ACTIVE_WINDOW_MS
      ? tasks.activity
      : [];
  // US-002: transcript-derived Skill firings. Skipped when there's no JSONL.
  const skillsFired = readSessionSkillFirings(sessionId, cwd);
  // US-003: persisted skill-consideration rows (fired=0 only — the rest come
  // from the skill-fired path).
  const skillsConsidered = listSkillConsideredFor(sessionId);
  // US-006: transcript-derived Plan records (TodoWrite + ExitPlanMode).
  const plans = readSessionPlans(sessionId, cwd);
  // Post-loop polish: per-assistant-turn token totals from the JSONL — fuel
  // for the +12k badge attached to STOP rows in buildTimeline.
  const assistantUsages = readAssistantTurnUsages(sessionId, cwd);
  return buildTimeline({
    events,
    activity: activeActivity,
    skillsFired,
    skillsConsidered,
    plans,
    assistantUsages,
    sessionCwd: cwd,
    activeCwd: getActiveCwd(),
    since: opts.since,
    limit,
  });
}
