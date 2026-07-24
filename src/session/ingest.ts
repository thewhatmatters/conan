import { getDb } from "../db/index.js";
import { getActiveCwd } from "../cwd/index.js";
import { readSkills } from "../skills/index.js";
import { scoreSkills, topMatches, CONSIDERATION_TOP_N } from "../skills/match.js";
import {
  ensureSkillFiredWatcher,
  readSessionSkillFirings,
  type SkillFiredRecord,
  type PlanRecord,
} from "../timeline/transcriptScan.js";
import { readAssistantTurnUsages } from "../transcript/index.js";
import { recordContextGrowth } from "../context/autorefresh.js";
import { autoRefreshContextOnStop } from "../terminal/index.js";

/**
 * Hook-event ingestion (US-003) — the implementation behind
 * `POST /api/claude/events`. Every hooked `claude` run self-reports its
 * lifecycle events here; one ingested event fans out into: the session +
 * event tables, a live `{type:'event'}` broadcast (with Stop-token
 * enrichment), the adaptive /context refresh accumulator, the per-session
 * skill-fired/plan transcript watcher, prompt-time skill consideration
 * (BM25 heuristic), and Stop-time fired reconciliation.
 *
 * The gateway route stays a thin adapter: auth + HTTP shapes there, the
 * pipeline here. `broadcast` is injected so this module never reaches into
 * the gateway's WebSocket server.
 */

/** Fan a message out to every connected app-WS client (gateway-injected). */
export type Broadcast = (message: unknown) => void;

export type IngestResult =
  | { ok: true; id: number }
  | { ok: false; error: string };

const db = getDb();

const IDLE_EVENTS = new Set(["Stop", "SessionEnd"]);

/** Byte size of a value as it contributes to context (string as-is, else JSON). */
function valueBytes(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return Buffer.byteLength(v);
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    return 0;
  }
}

/**
 * Output bytes a hook payload contributes to the session's context (US-002):
 * the tool_response (the bulk of context growth) plus any assistant message
 * text the payload carries. Used to drive the adaptive /context auto-refresh.
 */
function payloadOutputBytes(payload: Record<string, unknown>): number {
  return valueBytes(payload.tool_response) + valueBytes(payload.message);
}

/** Ingest one Claude Code lifecycle event: persist, broadcast, and feed the
 *  derived pipelines. The returned result maps 1:1 onto the route's HTTP
 *  answer (`ok:false` → 400). */
export function ingestClaudeEvent(
  b: Record<string, unknown>,
  broadcast: Broadcast,
): IngestResult {
  const sessionId = b.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, error: "session_id required" };
  }

  const now = Date.now();
  const hookEvent = typeof b.hook_event_name === "string" ? b.hook_event_name : null;
  const status = hookEvent && IDLE_EVENTS.has(hookEvent) ? "idle" : "running";

  // Capture the model from the hook payload (SessionStart and most events carry
  // it, e.g. "claude-opus-4-7[1m]") so observed sessions populate the Model &
  // idle widget (US-012). COALESCE keeps a known model when a later event omits
  // it. The model is nested in the forwarded hook payload, not at body top-level.
  const payload = (b.payload ?? null) as Record<string, unknown> | null;
  const model =
    payload && typeof payload.model === "string" ? payload.model : null;

  // Capture Claude Code's version from the SessionStart payload (US-001 v4.4)
  // so the session header can display it (US-008). The hook forwards the whole
  // payload, and SessionStart carries `version` (e.g. "2.1.152"). COALESCE keeps
  // a known version when a later event omits it; never fabricated (null when
  // absent).
  const claudeVersion =
    payload && typeof payload.version === "string" ? payload.version : null;

  // The hook reports the pid of the claude process that fired it (US-002
  // v1.0.2) for marker-independent pty↔session correlation. COALESCE keeps the
  // last known pid when an event omits it.
  const claudePid =
    typeof b.claudePid === "number" && Number.isInteger(b.claudePid) && b.claudePid > 0
      ? b.claudePid
      : null;

  db.prepare(
    `INSERT INTO session (id, cwd, model, claude_version, claude_pid, status, created_at, last_activity)
       VALUES (@id, @cwd, @model, @claudeVersion, @claudePid, @status, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       last_activity = @now,
       status = @status,
       cwd = COALESCE(excluded.cwd, session.cwd),
       model = COALESCE(excluded.model, session.model),
       claude_version = COALESCE(excluded.claude_version, session.claude_version),
       claude_pid = COALESCE(excluded.claude_pid, session.claude_pid)`,
  ).run({
    id: sessionId,
    cwd: typeof b.cwd === "string" ? b.cwd : null,
    model,
    claudeVersion,
    claudePid,
    status,
    now,
  });

  const info = db
    .prepare(
      `INSERT INTO event
         (session_id, parent_tool_use_id, hook_event_name, stream_type, tool_name, payload, ts)
       VALUES (?, ?, ?, 'hook', ?, ?, ?)`,
    )
    .run(
      sessionId,
      typeof b.parent_tool_use_id === "string" ? b.parent_tool_use_id : null,
      hookEvent,
      typeof b.tool_name === "string" ? b.tool_name : null,
      JSON.stringify(b.payload ?? b),
      now,
    );

  const event: {
    id: number;
    session_id: string;
    parent_tool_use_id: string | null;
    hook_event_name: string | null;
    stream_type: string;
    tool_name: string | null;
    payload: string;
    ts: number;
    /** Per-turn token total for Stop events — same enrichment the Timeline's
     *  REST backfill applies, mirrored here so live STOP rows arriving over
     *  WS render the `+Nk` badge without needing a refetch. */
    tokens?: number;
  } = {
    id: Number(info.lastInsertRowid),
    session_id: sessionId,
    parent_tool_use_id: typeof b.parent_tool_use_id === "string" ? b.parent_tool_use_id : null,
    hook_event_name: hookEvent,
    stream_type: "hook",
    tool_name: typeof b.tool_name === "string" ? b.tool_name : null,
    payload: JSON.stringify(b.payload ?? b),
    ts: now,
  };
  // On Stop, pull the just-ended turn's usage from the JSONL transcript. The
  // assistant message + its usage block lands in the transcript before the
  // Stop hook fires, so the last entry is the right one to attach. Empty/null
  // when the transcript isn't readable — UI just omits the badge in that case.
  if (hookEvent === "Stop") {
    const usages = readAssistantTurnUsages(
      sessionId,
      typeof b.cwd === "string" ? b.cwd : null,
    );
    const last = usages[usages.length - 1];
    if (last) event.tokens = last.totalTokens;
  }
  broadcast({ type: "event", payload: event });

  // Feed the adaptive /context auto-refresh accumulator (US-002): tool outputs
  // are the dominant driver of context growth between turns, so we size each
  // PostToolUse's tool_response (+ any assistant message text the payload
  // carries). The Stop handler then decides — from this delta plus a time
  // floor/ceiling — whether context has likely moved enough to be worth a
  // (token-costly) /context inject, instead of refreshing on every turn.
  if (hookEvent === "PostToolUse" && payload) {
    recordContextGrowth(sessionId, payloadOutputBytes(payload));
  }

  // On turn completion, adaptively refresh the live /context capture so the
  // Context widget stays current with the exact (1M-aware) window + breakdown —
  // delta-triggered (US-002), and safe when the session has no live pty.
  if (hookEvent === "Stop") autoRefreshContextOnStop(sessionId);

  // US-002 (v4.5): idempotently start a tail of the session's JSONL so each new
  // Skill tool_use broadcasts as a `{type:'skill-fired'}` row over /ws (kept
  // SEPARATE from {type:'event'} so existing consumers don't have to parse the
  // new kind). Prefer the transcript_path the hook payload carries; fall back
  // to resolving by cwd via transcriptPath() when missing.
  const transcriptPathHint =
    payload && typeof payload.transcript_path === "string"
      ? payload.transcript_path
      : null;
  const sessionCwdForScan =
    (typeof b.cwd === "string" ? b.cwd : null) ?? null;
  ensureSkillFiredWatcher(
    sessionId,
    {
      transcriptPath: transcriptPathHint,
      cwd: sessionCwdForScan,
    },
    (record) => emitSkillFired(sessionId, record, broadcast),
    // US-006 (v4.5): also broadcast TodoWrite + ExitPlanMode blocks as
    // `{type:'plan'}` envelopes — separate from `{type:'event'}`,
    // `{type:'skill-fired'}`, and `{type:'skill-considered'}` so consumers can
    // subscribe granularly.
    (record) => emitPlan(sessionId, record, broadcast),
  );

  // US-003 (v4.5): on a new prompt, heuristically score every installed skill
  // against the prompt text + persist the top N into prompt_consideration.
  // Broadcast each as a `{type:'skill-considered'}` envelope (separate kind
  // from {type:'event'} so existing consumers don't have to parse it). Honest
  // by construction — labelled as a heuristic in the UI (US-004), never as
  // Claude's real internal scoring.
  if (hookEvent === "UserPromptSubmit" && payload) {
    const promptText =
      typeof payload.prompt === "string" ? payload.prompt : "";
    if (promptText) {
      considerSkillsForPrompt(sessionId, event.id, now, promptText, broadcast);
    }
  }

  // US-003 (v4.5): at turn end, reconcile prompt_consideration for the latest
  // prompt: any considered skill whose name shows up in the transcript JSONL
  // slice since the prompt is flipped to fired=1 + a fired reason. The
  // skill-fired broadcast itself comes from US-002's live watcher; this step
  // keeps the persisted state honest for backfill (timeline reads).
  if (hookEvent === "Stop") {
    reconcileFiredForLatestPrompt(sessionId, sessionCwdForScan);
  }

  return { ok: true, id: event.id };
}

/**
 * Score every installed skill against the prompt text, persist the top N rows
 * into prompt_consideration keyed by the prompt's event id, and broadcast each
 * as a `{type:'skill-considered'}` envelope. The active cwd's project skills
 * are included (Claude considers them in this run too) — this mirrors what the
 * routing layer actually has visibility into.
 */
function considerSkillsForPrompt(
  sessionId: string,
  promptEventId: number,
  promptTs: number,
  promptText: string,
  broadcast: Broadcast,
): void {
  const skills = readSkills(getActiveCwd());
  if (skills.length === 0) return;
  const scored = scoreSkills(promptText, skills);
  const top = topMatches(scored, CONSIDERATION_TOP_N);
  if (top.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO prompt_consideration
       (event_id, skill, score, reason, fired, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(event_id, skill) DO UPDATE SET
       score = excluded.score,
       reason = excluded.reason,
       created_at = excluded.created_at`,
  );
  const persist = db.transaction((rows: typeof top) => {
    for (const r of rows) {
      insert.run(promptEventId, r.skill, r.score, r.reason, promptTs);
    }
  });
  persist(top);

  for (const r of top) {
    broadcast({
      type: "skill-considered",
      sessionId,
      payload: {
        kind: "skill-considered",
        ts: promptTs,
        eventId: promptEventId,
        skill: r.skill,
        promptEventId,
        reason: r.reason,
        heuristic: true,
      },
    });
  }
}

/**
 * Stop-time reconciliation: find the latest UserPromptSubmit event for the
 * session, read the transcript JSONL for any Skill tool_use blocks whose ts
 * lands after that prompt, and UPDATE prompt_consideration SET fired=1 +
 * reason='<fired_reason>' WHERE event_id=<prompt> AND skill IN (<fired set>).
 * Best-effort: a session with no transcript / no preceding prompt / no fired
 * skills is a no-op. The matching rows' kind in subsequent timeline reads
 * flips from skill-considered to skill-fired (Timeline excludes fired=1 rows).
 */
function reconcileFiredForLatestPrompt(
  sessionId: string,
  cwd: string | null,
): void {
  const latestPrompt = db
    .prepare(
      `SELECT id, ts FROM event
        WHERE session_id = ?
          AND stream_type = 'hook'
          AND hook_event_name = 'UserPromptSubmit'
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId) as { id: number; ts: number } | undefined;
  if (!latestPrompt) return;

  const firings = readSessionSkillFirings(sessionId, cwd);
  if (firings.length === 0) return;
  const firedSinceLatest = firings.filter((f) => f.ts > latestPrompt.ts);
  if (firedSinceLatest.length === 0) return;
  const firedSet = new Set(firedSinceLatest.map((f) => f.skill));
  if (firedSet.size === 0) return;

  const update = db.prepare(
    `UPDATE prompt_consideration
        SET fired = 1, reason = ?
      WHERE event_id = ? AND skill = ?`,
  );
  const apply = db.transaction((skillNames: string[]) => {
    for (const name of skillNames) {
      update.run("fired (matched transcript tool_use)", latestPrompt.id, name);
    }
  });
  apply(Array.from(firedSet));
}

/**
 * Resolve the latest UserPromptSubmit event id whose ts < the firing's ts,
 * scoped to this session. Used to link a skill-fired broadcast back to the
 * prompt that triggered it; null when no preceding prompt exists.
 */
function latestPromptEventIdBefore(
  sessionId: string,
  ts: number,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM event
        WHERE session_id = ?
          AND stream_type = 'hook'
          AND hook_event_name = 'UserPromptSubmit'
          AND ts < ?
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
    )
    .get(sessionId, ts) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Broadcast one new Skill firing over the app WS as a TimelineRow envelope.
 * Kept separate from `{type:'event'}` so existing consumers don't have to parse
 * the new kind (US-002 acceptance).
 */
function emitSkillFired(
  sessionId: string,
  record: SkillFiredRecord,
  broadcast: Broadcast,
): void {
  const promptEventId = latestPromptEventIdBefore(sessionId, record.ts);
  broadcast({
    type: "skill-fired",
    sessionId,
    payload: {
      kind: "skill-fired",
      ts: record.ts,
      skill: record.skill,
      ...(promptEventId !== null ? { promptEventId } : {}),
      detail: `Skill: ${record.skill}`,
    },
  });
}

/**
 * Broadcast one new Plan record (TodoWrite or ExitPlanMode) over the app WS as
 * a TimelineRow envelope (US-006). promptEventId is resolved the same way as
 * the skill-fired path — latest UserPromptSubmit for this session before the
 * block's ts. Kept on its own `{type:'plan'}` channel so existing
 * {type:'event'}/{type:'skill-fired'}/{type:'skill-considered'} consumers don't
 * have to parse the new kind.
 */
function emitPlan(
  sessionId: string,
  record: PlanRecord,
  broadcast: Broadcast,
): void {
  const promptEventId = latestPromptEventIdBefore(sessionId, record.ts);
  const idFields =
    promptEventId !== null ? { eventId: promptEventId, promptEventId } : {};
  const payload =
    record.subtype === "todo-write"
      ? {
          kind: "plan" as const,
          ts: record.ts,
          subtype: "todo-write" as const,
          ...idFields,
          items: record.items,
        }
      : {
          kind: "plan" as const,
          ts: record.ts,
          subtype: "plan-mode" as const,
          ...idFields,
          plan: record.plan,
        };
  broadcast({ type: "plan", sessionId, payload });
}
