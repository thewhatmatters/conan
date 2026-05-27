import { getDb } from "../db/index.js";

// v4.2 (US-003) is Tauri-only and no longer DRIVES headless sessions: the
// launch/steer (start / sendPrompt / resume / stop / decidePermission) control
// plane, its stream-json parser, worktree isolation, and JSON-schema validation
// were removed. Sessions are now purely OBSERVED — any hooked `claude` self-
// reports over POST /api/claude/events, and a pty is correlated to its session
// by the terminal layer. What remains here are the read helpers the kept routes
// need: the session grid (GET /api/claude/sessions), the event timeline, and the
// interactive permission prompts surfaced from a correlated pty's latest event.

/** A session row as exposed to the dashboard (US-009 session grid). */
export interface SessionRow {
  id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  permission_mode: string | null;
  /** Claude Code version captured from the SessionStart hook (US-001 v4.4); null if unknown. */
  claude_version: string | null;
  status: string;
  color: string | null;
  created_at: number;
  last_activity: number;
  total_cost_usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  context_tokens: number | null;
  worktree_path: string | null;
  worktree_base_ref: string | null;
  json_schema: string | null;
  structured_result: string | null;
  schema_valid: number | null;
}

/**
 * All persisted sessions, newest activity first, for the dashboard grid
 * (US-009). Backed by the session table written by the hook ingest (US-003).
 */
export function listSessions(): SessionRow[] {
  return getDb()
    .prepare(
      `SELECT id, title, cwd, model, permission_mode, claude_version, status, color,
              created_at, last_activity, total_cost_usd,
              input_tokens, output_tokens, context_tokens,
              worktree_path, worktree_base_ref,
              json_schema, structured_result, schema_valid
         FROM session
         ORDER BY last_activity DESC`,
    )
    .all() as SessionRow[];
}

/** One persisted event row as exposed to the dashboard timeline (US-011). */
export interface EventRow {
  id: number;
  session_id: string;
  parent_tool_use_id: string | null;
  hook_event_name: string | null;
  stream_type: string | null;
  tool_name: string | null;
  payload: string | null;
  ts: number;
}

/**
 * A session's persisted events, oldest first, for the ActivityTimeline
 * (US-011). Includes the raw payload so the UI can render prompt text, tool
 * inputs, and retry/compaction detail.
 */
export function listEvents(sessionId: string, limit = 1000): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, session_id, parent_tool_use_id, hook_event_name,
              stream_type, tool_name, payload, ts
         FROM event
         WHERE session_id = ?
         ORDER BY ts ASC, id ASC
         LIMIT ?`,
    )
    .all(sessionId, limit) as EventRow[];
}

/**
 * Recent events across every session, oldest-first, for the timeline's
 * "All sessions" view (US-007). Takes the most-recent `limit` rows (newest
 * activity) then re-orders them ascending so the timeline reads top-to-bottom
 * like a single-session view.
 *
 * Pass `cwd` to scope to events from sessions in that working directory
 * (US-002 multi-project observatory) — events carry no cwd of their own, so we
 * join to the owning session row.
 */
export function listAllEvents(limit = 1000, cwd?: string): EventRow[] {
  const sql = cwd
    ? `SELECT e.id, e.session_id, e.parent_tool_use_id, e.hook_event_name,
              e.stream_type, e.tool_name, e.payload, e.ts
         FROM event e JOIN session s ON s.id = e.session_id
         WHERE s.cwd = ?
         ORDER BY e.ts DESC, e.id DESC
         LIMIT ?`
    : `SELECT id, session_id, parent_tool_use_id, hook_event_name,
              stream_type, tool_name, payload, ts
         FROM event
         ORDER BY ts DESC, id DESC
         LIMIT ?`;
  const rows = (cwd
    ? getDb().prepare(sql).all(cwd, limit)
    : getDb().prepare(sql).all(limit)) as EventRow[];
  return rows.reverse();
}

/** A tool-permission prompt awaiting an operator decision (US-012). */
export interface PendingPermission {
  requestId: string;
  toolName: string | null;
  input: unknown;
  ts: number;
  /** The prompt's real `permission_suggestions`, passed through untouched. */
  permissionSuggestions?: unknown;
}

/** A permission prompt across sessions (US-012; feeds the approvals widget). */
export interface SessionPermission extends PendingPermission {
  sessionId: string;
  /**
   * How a decision reaches this prompt (US-009). With driving removed (US-003)
   * every surfaced prompt is interactive — answered by typing into the
   * correlated pty — so this is always "keystroke".
   */
  delivery: "stdin" | "keystroke";
}

/**
 * Driven sessions no longer exist (US-003 removed the drive control plane), so
 * there are never stdin-answerable pending prompts. Kept as an honest empty
 * source for the approvals route until that route itself is removed.
 */
export function listPendingPermissions(): SessionPermission[] {
  return [];
}

/** How stale an interactive permission Notification may be and still count. */
const INTERACTIVE_PERMISSION_MAX_AGE_MS = 30 * 60_000;

/**
 * Decide whether a session's latest event is an unanswered permission prompt
 * (US-009). For an observed/interactive session the prompt isn't a stream-json
 * control_request — it's the TUI's own prompt, surfaced to us only as a
 * permission-type `Notification` hook. We treat that Notification as pending
 * while it remains the *latest* event for the session: once the operator
 * answers (in the terminal or via keystroke injection) a newer event — the
 * tool's PreToolUse, a Stop, the next prompt — supersedes it.
 */
function asPermissionNotification(
  row: { hook_event_name: string | null; tool_name: string | null; payload: string | null },
): { toolName: string | null; input: unknown } | null {
  if (row.hook_event_name !== "Notification") return null;
  let payload: Record<string, unknown> | null = null;
  try {
    payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  const message = typeof payload?.message === "string" ? payload.message.toLowerCase() : "";
  const isPermission =
    message.includes("permission") ||
    payload?.permission_decision != null ||
    payload?.permission_mode != null;
  if (!isPermission) return null;
  const toolName =
    row.tool_name ?? (typeof payload?.tool_name === "string" ? payload.tool_name : null);
  return { toolName, input: payload?.tool_input ?? payload?.input ?? null };
}

/**
 * Interactive/observed permission prompts (US-009): a permission-type
 * `Notification` is the latest event for a session that has a live, correlated
 * pty. Each is answerable only by typing into that pty, so the caller passes the
 * set of session ids with a live terminal (`liveTerminalSessions`, from the
 * terminal module) — prompts without one are omitted, leaving the UI's honest
 * non-deliverable path to cover them. Tagged `delivery:"keystroke"` and carries
 * a synthetic `notif-<eventId>` request id (there is no stream-json request to
 * match).
 */
export function listInteractivePermissions(
  liveTerminalSessions: Set<string>,
): SessionPermission[] {
  if (liveTerminalSessions.size === 0) return [];
  const cutoff = Date.now() - INTERACTIVE_PERMISSION_MAX_AGE_MS;
  const db = getDb();
  const out: SessionPermission[] = [];
  for (const sessionId of liveTerminalSessions) {
    const row = db
      .prepare(
        `SELECT id, hook_event_name, tool_name, payload, ts
           FROM event WHERE session_id = ?
           ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as
      | { id: number; hook_event_name: string | null; tool_name: string | null; payload: string | null; ts: number }
      | undefined;
    if (!row || row.ts < cutoff) continue;
    const prompt = asPermissionNotification(row);
    if (!prompt) continue;
    out.push({
      sessionId,
      requestId: `notif-${row.id}`,
      toolName: prompt.toolName,
      input: prompt.input,
      ts: row.ts,
      delivery: "keystroke",
    });
  }
  return out;
}
