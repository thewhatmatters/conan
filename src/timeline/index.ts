import { type EventRow } from "../session/index.js";
import { getDb } from "../db/index.js";
import { readTasks } from "../tasks/index.js";
import { getActiveCwd } from "../cwd/index.js";
import {
  readSessionSkillFirings,
  type SkillFiredRecord,
} from "./transcriptScan.js";

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

/** Loop event subtypes derived from a progress.txt activity line. */
export type LoopSubtype = "iteration" | "pass" | "trail";

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
    }
  | {
      kind: "loop";
      ts: number;
      subtype: LoopSubtype;
      title: string;
      detail?: string;
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
      subtype = "PROMPT";
      const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
      title = prompt ? truncate(prompt, 160) : "(empty prompt)";
      break;
    }
    case "PreToolUse":
    case "PostToolUse": {
      subtype = name === "PreToolUse" ? "PRETOOL" : "POSTTOOL";
      const tool =
        row.tool_name ?? (typeof payload?.tool_name === "string" ? payload.tool_name : "");
      const arg = firstStringArg(payload?.tool_input);
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

  let subtype: LoopSubtype = "trail";
  if (/iteration\s+\d+/i.test(body) || /→\s*US-/.test(body)) subtype = "iteration";
  else if (/\bUS-\d+\b.*\b(?:done|pass(?:es)?)\b/i.test(body) || /passes:\s*true/i.test(body))
    subtype = "pass";

  return {
    kind: "loop",
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
  /** The session's cwd, from the session row. Used to gate loop rows. */
  sessionCwd: string | null;
  /** The cwd progress.txt itself is read from (the build-loop's project). */
  activeCwd: string;
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

  const all = [...hookRows, ...loopRows, ...skillRows];
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
  // US-002: transcript-derived Skill firings. Skipped when there's no JSONL.
  const skillsFired = readSessionSkillFirings(sessionId, cwd);
  // US-003: persisted skill-consideration rows (fired=0 only — the rest come
  // from the skill-fired path).
  const skillsConsidered = listSkillConsideredFor(sessionId);
  return buildTimeline({
    events,
    activity: tasks.activity,
    skillsFired,
    skillsConsidered,
    sessionCwd: cwd,
    activeCwd: getActiveCwd(),
    since: opts.since,
    limit,
  });
}
