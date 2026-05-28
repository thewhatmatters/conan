// US-002 (v4.5): transcript-derived skill firings — the ground-truth feed of
// which Skills actually fired in a session, extracted from Claude Code's session
// JSONL. Used by two consumers:
//   - the Timeline route (src/timeline/index.ts) merges these as `skill-fired`
//     envelopes into the per-session chronological feed.
//   - the Skills HUD tab (GET /api/claude/skills) enriches each SkillEntry with
//     a `lastFiredAt: number | null` so users can spot real usage.
//
// Honest by construction: we extract Skill tool_use blocks only — no inference,
// no scoring. A transcript without any Skill block yields []. A missing/
// unreadable JSONL yields []. Timestamps come from the message-level `timestamp`
// the JSONL carries; we never fabricate one.
//
// A live watcher (fs.watch + size-delta tail) emits each new Skill block over
// the app WS as a separate `{type:'skill-fired'}` broadcast so existing
// {type:'event'} consumers don't have to parse the new kind.
import fs from "node:fs";
import path from "node:path";
import { transcriptPath } from "../transcript/index.js";
import { HOME } from "../paths.js";

/** One Skill tool_use record extracted from a transcript JSONL. */
export interface SkillFiredRecord {
  /** The skill name from the Skill tool's `input.skill`. */
  skill: string;
  /** Epoch ms parsed from the assistant message's ISO `timestamp`. */
  ts: number;
}

/** One TodoWrite checklist item, as Claude Code emits it in tool_use input. */
export interface PlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/**
 * One TodoWrite or ExitPlanMode tool_use record extracted from a transcript
 * JSONL (US-006). Discriminated union — `items` is set for `todo-write`,
 * `plan` is set for `plan-mode`; the other field is omitted. Same `ts`
 * convention as SkillFiredRecord (the assistant message's epoch ms).
 */
export type PlanRecord =
  | { subtype: "todo-write"; ts: number; items: PlanItem[] }
  | { subtype: "plan-mode"; ts: number; plan: string };

/**
 * Parse a JSONL transcript's raw text into chronological Skill records.
 * Pure — no fs, no DB. Skips malformed lines, non-assistant lines, lines with
 * no Skill tool_use block, and lines whose timestamp won't parse. Returns
 * records in source order (file order is chronological in Claude Code JSONL).
 */
export function extractSkillBlocks(raw: string): SkillFiredRecord[] {
  const out: SkillFiredRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Cheap pre-filter so a megabyte transcript without skills doesn't JSON.parse
    // every line. The JSON ordering Claude Code emits puts these as adjacent
    // key/value pairs, so the literal substring is reliable.
    if (line.indexOf('"name":"Skill"') === -1) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "assistant") continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use" || b.name !== "Skill") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const skill = typeof input.skill === "string" ? input.skill.trim() : "";
      if (!skill) continue;
      out.push({ skill, ts });
    }
  }
  return out;
}

/** Read a JSONL file from disk and return its Skill records, or [] on error. */
export function readTranscriptSkills(filePath: string): SkillFiredRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return extractSkillBlocks(raw);
}

/** Allow-list of TodoWrite item statuses. */
function isPlanStatus(s: string): s is PlanItem["status"] {
  return s === "pending" || s === "in_progress" || s === "completed";
}

/**
 * Parse a JSONL transcript's raw text into chronological Plan records — every
 * TodoWrite + ExitPlanMode tool_use block (US-006). Same shape as
 * extractSkillBlocks: pure, no fs, no fabrication. A non-string `plan` field or
 * a missing/non-array `todos` field skips that block. Source order is
 * preserved (file order is chronological in Claude Code JSONL).
 */
export function extractPlanBlocks(raw: string): PlanRecord[] {
  const out: PlanRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Cheap pre-filter — only parse lines that mention one of the two tool
    // names. A megabyte transcript without plan blocks is then ~free.
    if (
      line.indexOf('"name":"TodoWrite"') === -1 &&
      line.indexOf('"name":"ExitPlanMode"') === -1
    )
      continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "assistant") continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (b.name === "TodoWrite") {
        const todosRaw = input.todos;
        if (!Array.isArray(todosRaw)) continue;
        const items: PlanItem[] = [];
        for (const t of todosRaw) {
          if (!t || typeof t !== "object") continue;
          const ti = t as Record<string, unknown>;
          const itemContent = typeof ti.content === "string" ? ti.content : "";
          const status = typeof ti.status === "string" ? ti.status : "";
          if (!itemContent || !isPlanStatus(status)) continue;
          const item: PlanItem = { content: itemContent, status };
          if (typeof ti.activeForm === "string" && ti.activeForm.length > 0) {
            item.activeForm = ti.activeForm;
          }
          items.push(item);
        }
        out.push({ subtype: "todo-write", ts, items });
      } else if (b.name === "ExitPlanMode") {
        const plan = typeof input.plan === "string" ? input.plan : "";
        if (!plan) continue;
        out.push({ subtype: "plan-mode", ts, plan });
      }
    }
  }
  return out;
}

/** Read a JSONL file from disk and return its Plan records, or [] on error. */
export function readTranscriptPlans(filePath: string): PlanRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return extractPlanBlocks(raw);
}

/**
 * Read a session's Plan records via the canonical transcriptPath resolver.
 * Returns [] when the JSONL can't be located (no fabrication).
 */
export function readSessionPlans(
  sessionId: string,
  cwd?: string | null,
): PlanRecord[] {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return [];
  return readTranscriptPlans(file);
}

/**
 * Read a session's Skill firings via the canonical transcriptPath resolver.
 * Returns [] when the JSONL can't be located (no fabrication).
 */
export function readSessionSkillFirings(
  sessionId: string,
  cwd?: string | null,
): SkillFiredRecord[] {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return [];
  return readTranscriptSkills(file);
}

/** Cap on how many JSONL files the lastFiredAt scan reads in one pass. */
const LAST_FIRED_MAX_FILES = 50;
/** How far back the lastFiredAt scan looks (mtime-bounded). */
const LAST_FIRED_MAX_AGE_DAYS = 30;

/**
 * Most-recent Skill firing timestamp per skill name across recent transcripts.
 * Bounded scan over ~/.claude/projects/<encoded-cwd>/*.jsonl: takes the N
 * most-recently-modified JSONLs whose mtime falls within `maxAgeDays`, parses
 * each for Skill blocks, and keeps the max ts per skill. Returns an empty Map
 * when ~/.claude/projects is missing or unreadable — never throws.
 */
export function scanRecentSkillFirings(
  opts: { maxFiles?: number; maxAgeDays?: number } = {},
): Map<string, number> {
  const maxFiles = opts.maxFiles ?? LAST_FIRED_MAX_FILES;
  const maxAgeMs = (opts.maxAgeDays ?? LAST_FIRED_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const result = new Map<string, number>();

  const root = path.join(HOME, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return result;
  }

  const candidates: { file: string; mtime: number }[] = [];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dirPath, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) continue;
        candidates.push({ file: full, mtime: st.mtimeMs });
      } catch {
        /* unreadable — skip */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const { file } of candidates.slice(0, maxFiles)) {
    for (const r of readTranscriptSkills(file)) {
      const prev = result.get(r.skill);
      if (prev === undefined || r.ts > prev) result.set(r.skill, r.ts);
    }
  }
  return result;
}

/** Live-watcher state per session — kept module-private. */
interface WatcherState {
  filePath: string;
  /** Byte offset we've already consumed up to in the JSONL. */
  offset: number;
  /** Partial line accumulator across tail reads (a write may split a line). */
  buf: string;
  watcher: fs.FSWatcher | null;
}

const watchers = new Map<string, WatcherState>(); // by sessionId

/**
 * Tail the file once: read any bytes past our remembered offset, parse complete
 * lines (the trailing partial is kept until the next write), and fire
 * `onFire(record)` for every new Skill block. When `onPlan` is supplied
 * (US-006), also extracts TodoWrite + ExitPlanMode blocks from the same slice
 * and emits them. Handles file truncation/rotation by resetting the offset
 * down to the current size.
 */
function tail(
  state: WatcherState,
  onFire: (record: SkillFiredRecord) => void,
  onPlan?: (record: PlanRecord) => void,
): void {
  let size: number;
  try {
    size = fs.statSync(state.filePath).size;
  } catch {
    return;
  }
  if (size < state.offset) {
    // File was truncated/rotated — restart from the new end.
    state.offset = size;
    state.buf = "";
    return;
  }
  if (size === state.offset) return;

  let fd: number;
  try {
    fd = fs.openSync(state.filePath, "r");
  } catch {
    return;
  }
  try {
    const length = size - state.offset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, state.offset);
    state.offset = size;
    state.buf += buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }

  // Process complete lines (everything up to the last newline).
  const nl = state.buf.lastIndexOf("\n");
  if (nl < 0) return; // no complete line yet — keep accumulating
  const ready = state.buf.slice(0, nl);
  state.buf = state.buf.slice(nl + 1);
  for (const record of extractSkillBlocks(ready)) onFire(record);
  if (onPlan) {
    for (const record of extractPlanBlocks(ready)) onPlan(record);
  }
}

/**
 * Start tailing a session's transcript for new Skill firings. Idempotent: a
 * repeat call for the same session is a no-op. The watcher seeks to the file's
 * current end so it only emits firings that happen *after* this call — the
 * Timeline route's mount-time backfill (US-001 → readTimeline) covers history.
 * No-ops when the transcript can't be resolved (the session has no JSONL yet).
 */
export function ensureSkillFiredWatcher(
  sessionId: string,
  opts: { transcriptPath?: string | null; cwd?: string | null },
  onFire: (record: SkillFiredRecord) => void,
  onPlan?: (record: PlanRecord) => void,
): void {
  if (watchers.has(sessionId)) return;
  const file =
    (opts.transcriptPath && typeof opts.transcriptPath === "string"
      ? opts.transcriptPath
      : null) ?? transcriptPath(sessionId, opts.cwd ?? null);
  if (!file) return;
  let initialSize = 0;
  try {
    initialSize = fs.statSync(file).size;
  } catch {
    return; // file vanished between resolve and stat — bail
  }
  const state: WatcherState = {
    filePath: file,
    offset: initialSize,
    buf: "",
    watcher: null,
  };
  try {
    state.watcher = fs.watch(file, { persistent: false }, () =>
      tail(state, onFire, onPlan),
    );
  } catch {
    return; // platform refused the watch — skip silently (we'll backfill on read)
  }
  watchers.set(sessionId, state);
}

/** Stop every active watcher (gateway shutdown). */
export function stopAllSkillFiredWatchers(): void {
  for (const s of watchers.values()) {
    try {
      s.watcher?.close();
    } catch {
      /* ignore */
    }
  }
  watchers.clear();
}
