import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getDb } from "../db/index.js";
import { PACKAGE_ROOT } from "../paths.js";
import {
  parseStreamMessage,
  type NormalizedEvent,
  type UsageUpdate,
} from "./parser.js";
import { createWorktree, removeWorktree, type WorktreeInfo } from "./worktree.js";
import { isPlausibleSchema, validateAgainstSchema } from "./json-schema.js";

/** The `claude` binary to launch headless; override with CONAN_CLAUDE_BIN. */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/** Valid `--effort` levels accepted by the CLI (US-042). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Narrow an arbitrary value to a valid `--effort` level. */
export function isValidEffort(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export interface StartSessionOptions {
  /** Working directory the agent runs in. Defaults to the repo root. */
  cwd?: string;
  /** Model alias/slug passed via --model (e.g. "sonnet", "opus"). */
  model?: string;
  /** Permission mode passed via --permission-mode (default|acceptEdits|plan|dontAsk). */
  permissionMode?: string;
  /** Effort level passed via --effort (low|medium|high|xhigh|max); unset = CLI default. */
  effort?: string;
  /** Resume a session linked to a GitHub PR, passed via --from-pr <n> (US-042). */
  fromPr?: string;
  /** Append --bare for a reproducible, minimal-config launch. */
  bare?: boolean;
  /**
   * Run the session in a fresh git worktree cut off `cwd`'s repo (US-043), so
   * parallel driven runs don't collide. The worktree path becomes the cwd and
   * is surfaced on the session row. Defaults off — cwd is used as-is.
   */
  worktree?: boolean;
  /** Base ref the worktree branch is cut from when `worktree` is set; default HEAD. */
  worktreeRef?: string;
  /** Extra directories granted to the session via `--add-dir <path>` (US-043). */
  addDirs?: string[];
  /**
   * JSON Schema the task's final result must conform to (US-044). When a
   * plausible (non-array object) schema is supplied it is written to a temp
   * file and passed via `--json-schema <path>`; the final result is then
   * captured and validated against it on the session row. A missing or
   * malformed schema is ignored — defaults are unchanged.
   */
  jsonSchema?: unknown;
  /** Optional first prompt. When omitted the session reads prompts over stdin. */
  prompt?: string;
  /** UI session color, persisted onto the session row. */
  color?: string;
}

/** A headless Claude Code child process tracked by the session manager. */
export interface ManagedSession {
  /** Internal id assigned at spawn, before the real session_id is known. */
  launchId: string;
  /** Claude Code session_id from the system/init event; null until captured. */
  sessionId: string | null;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  model?: string;
  permissionMode?: string;
  /** Worktree this session was launched into (US-043); undefined for normal runs. */
  worktreePath?: string;
  /** Base ref the worktree branch was cut from (US-043). */
  worktreeBaseRef?: string;
  /** JSON Schema the final result is validated against (US-044); undefined if none. */
  jsonSchema?: unknown;
  /** Temp file holding the serialized schema, unlinked on exit (US-044). */
  schemaFile?: string;
  startedAt: number;
  /**
   * Open tool-permission prompts keyed by control_request id (US-012). The CLI
   * blocks on stdin until we send a matching control_response, so we track the
   * original input to echo back when allowing and to resolve an omitted id.
   */
  pending: Map<string, PendingPermission>;
}

/** A tool-permission prompt awaiting an operator decision (US-012). */
export interface PendingPermission {
  requestId: string;
  toolName: string | null;
  input: unknown;
  ts: number;
}

// Two views of the same set of live children. We can't key by session_id at
// spawn time (it arrives in system/init), so we key by launchId first and add
// the session_id mapping once captured (acceptance criterion #4).
const byLaunchId = new Map<string, ManagedSession>();
const bySessionId = new Map<string, ManagedSession>();

/** Look up a live managed session by its Claude Code session_id. */
export function getManagedSession(sessionId: string): ManagedSession | undefined {
  return bySessionId.get(sessionId);
}

/** All currently-tracked live sessions. */
export function listManagedSessions(): ManagedSession[] {
  return [...byLaunchId.values()];
}

/** A session row as exposed to the dashboard (US-009 session grid). */
export interface SessionRow {
  id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  permission_mode: string | null;
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
 * (US-009). Backed by the session table written by the hook ingest (US-003)
 * and the stream-json parser (US-007).
 */
export function listSessions(): SessionRow[] {
  return getDb()
    .prepare(
      `SELECT id, title, cwd, model, permission_mode, status, color,
              created_at, last_activity, total_cost_usd,
              input_tokens, output_tokens, context_tokens,
              worktree_path, worktree_base_ref,
              json_schema, structured_result, schema_valid
         FROM session
         ORDER BY last_activity DESC`,
    )
    .all() as SessionRow[];
}

/**
 * Build the headless argv. Per US-006 the core invocation is
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 * We additionally request stream-json *input* so the process stays alive to
 * receive follow-up prompts (US-008); a one-shot `prompt` is passed positionally.
 */
function buildArgs(opts: StartSessionOptions, schemaFile?: string): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (opts.prompt === undefined) {
    args.push("--input-format", "stream-json");
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (isValidEffort(opts.effort)) args.push("--effort", opts.effort);
  if (opts.fromPr) args.push("--from-pr", opts.fromPr);
  for (const dir of opts.addDirs ?? []) {
    if (dir.trim()) args.push("--add-dir", dir.trim());
  }
  // US-044: constrain the final result to a JSON schema (written to schemaFile).
  if (schemaFile) args.push("--json-schema", schemaFile);
  if (opts.bare) args.push("--bare");
  if (opts.prompt !== undefined) args.push(opts.prompt);
  return args;
}

/**
 * Serialize a plausible JSON schema to a temp file for `--json-schema <path>`
 * (US-044). Returns the path, or undefined when the schema is missing/malformed
 * so the launch falls back to default (unconstrained) output.
 */
function writeSchemaFile(jsonSchema: unknown): string | undefined {
  if (!isPlausibleSchema(jsonSchema)) return undefined;
  const file = path.join(
    os.tmpdir(),
    `conan-schema-${crypto.randomUUID()}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(jsonSchema), "utf8");
  return file;
}

/**
 * Build the child env. Headless Claude Code must authenticate with
 * ANTHROPIC_API_KEY — OAuth tokens (sk-ant-oat*) are blocked for third-party
 * API calls (see CLAUDE.md), so we never forward one into a headless launch.
 */
function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Strip any OAuth token so the API key is the only credential in play.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.startsWith("sk-ant-oat")) {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
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

// Listeners notified whenever the parser persists a stream-json event, so the
// gateway can broadcast headless-session activity live over /ws (US-011). The
// hook-ingest path broadcasts from the route directly; this covers the parser.
type EventListener = (ev: EventRow) => void;
const eventListeners = new Set<EventListener>();

/** Subscribe to persisted stream-json events; returns an unsubscribe fn. */
export function onSessionEvent(cb: EventListener): () => void {
  eventListeners.add(cb);
  return () => {
    eventListeners.delete(cb);
  };
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

/** Insert one normalized stream-json event for a known session_id (US-007). */
function persistEvent(sessionId: string, ev: NormalizedEvent): number {
  const ts = Date.now();
  const payload = JSON.stringify(ev.payload ?? null);
  const info = getDb()
    .prepare(
      `INSERT INTO event
         (session_id, parent_tool_use_id, hook_event_name, stream_type, tool_name, payload, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      ev.parentToolUseId,
      ev.hookEventName,
      ev.streamType,
      ev.toolName,
      payload,
      ts,
    );
  const id = Number(info.lastInsertRowid);
  if (eventListeners.size) {
    const row: EventRow = {
      id,
      session_id: sessionId,
      parent_tool_use_id: ev.parentToolUseId,
      hook_event_name: ev.hookEventName,
      stream_type: ev.streamType,
      tool_name: ev.toolName,
      payload,
      ts,
    };
    for (const cb of eventListeners) cb(row);
  }
  return id;
}

/** Fold token/cost figures from a parsed message onto the session row. */
function applyUsage(sessionId: string, u: UsageUpdate): void {
  const sets: string[] = ["last_activity = @now"];
  const params: Record<string, unknown> = { id: sessionId, now: Date.now() };
  const col: Record<keyof UsageUpdate, string> = {
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    cacheReadInputTokens: "cache_read_input_tokens",
    cacheCreationInputTokens: "cache_creation_input_tokens",
    contextTokens: "context_tokens",
    totalCostUsd: "total_cost_usd",
  };
  for (const key of Object.keys(col) as Array<keyof UsageUpdate>) {
    const value = u[key];
    if (value !== undefined) {
      sets.push(`${col[key]} = @${key}`);
      params[key] = value;
    }
  }
  if (sets.length === 1) return; // only last_activity — nothing useful to write
  getDb()
    .prepare(`UPDATE session SET ${sets.join(", ")} WHERE id = @id`)
    .run(params);
}

/** Upsert the session row once we know its real session_id. */
function persistSession(s: ManagedSession): void {
  if (!s.sessionId) return;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO session
         (id, cwd, model, permission_mode, status, created_at, last_activity,
          worktree_path, worktree_base_ref, json_schema)
         VALUES (@id, @cwd, @model, @permissionMode, 'running', @startedAt, @now,
                 @worktreePath, @worktreeBaseRef, @jsonSchema)
       ON CONFLICT(id) DO UPDATE SET
         status = 'running',
         last_activity = @now,
         cwd = COALESCE(excluded.cwd, session.cwd),
         model = COALESCE(excluded.model, session.model),
         permission_mode = COALESCE(excluded.permission_mode, session.permission_mode),
         worktree_path = COALESCE(excluded.worktree_path, session.worktree_path),
         worktree_base_ref = COALESCE(excluded.worktree_base_ref, session.worktree_base_ref),
         json_schema = COALESCE(excluded.json_schema, session.json_schema)`,
    )
    .run({
      id: s.sessionId,
      cwd: s.cwd,
      model: s.model ?? null,
      permissionMode: s.permissionMode ?? null,
      worktreePath: s.worktreePath ?? null,
      worktreeBaseRef: s.worktreeBaseRef ?? null,
      jsonSchema: s.jsonSchema !== undefined ? JSON.stringify(s.jsonSchema) : null,
      startedAt: s.startedAt,
      now,
    });
}

/**
 * Capture the structured output of a finished driven session (US-044): pull the
 * `result` field off the final result message, validate it against the
 * session's JSON schema, and persist both the captured result and the
 * pass/fail flag on the session row. No-op when the session carried no schema.
 */
function captureStructuredResult(s: ManagedSession, resultPayload: unknown): void {
  if (!s.sessionId || s.jsonSchema === undefined) return;
  const p = (resultPayload ?? {}) as Record<string, unknown>;
  // The structured output rides in `result`; when emitted as a JSON string,
  // parse it so we validate (and surface) the object rather than its text.
  let value: unknown = p.result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Leave as the raw string; validation will flag the type mismatch.
    }
  }
  const { valid } = validateAgainstSchema(value, s.jsonSchema);
  getDb()
    .prepare(
      `UPDATE session SET structured_result = @result, schema_valid = @valid,
              last_activity = @now WHERE id = @id`,
    )
    .run({
      id: s.sessionId,
      result: JSON.stringify(value ?? null),
      valid: valid ? 1 : 0,
      now: Date.now(),
    });
}

export interface StartSessionResult {
  launchId: string;
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the captured session_id once system/init is seen. */
  sessionId: Promise<string>;
  /** The worktree the session runs in, when launched with `worktree` (US-043). */
  worktree?: WorktreeInfo;
}

/** Internal launch config shared by start (US-006) and resume (US-008). */
interface LaunchConfig {
  cwd: string;
  model?: string;
  permissionMode?: string;
  /** Worktree the session runs in, surfaced on the row (US-043). */
  worktree?: WorktreeInfo;
  /** JSON schema the final result is validated against (US-044). */
  jsonSchema?: unknown;
  /** Temp file holding the serialized schema, unlinked on exit (US-044). */
  schemaFile?: string;
  /**
   * Known session_id, set when resuming. Lets us register the child in
   * `bySessionId` and resolve the id promise immediately so a follow-up
   * sendPrompt can find the live process before system/init echoes back.
   */
  knownSessionId?: string;
}

/**
 * Spawn the stream-json CLI, track the child handle, and wire up the US-007
 * stream parser (capture session_id from system/init, persist each event,
 * fold token/cost usage onto the row). Shared by startSession and
 * resumeSession; returns immediately with a promise for the id.
 */
function launch(args: string[], cfg: LaunchConfig): StartSessionResult {
  const launchId = crypto.randomUUID();
  const worktree = cfg.worktree;

  const child = spawn(CLAUDE_BIN, args, {
    cwd: cfg.cwd,
    env: sessionEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const session: ManagedSession = {
    launchId,
    sessionId: cfg.knownSessionId ?? null,
    child,
    cwd: cfg.cwd,
    model: cfg.model,
    permissionMode: cfg.permissionMode,
    worktreePath: cfg.worktree?.path,
    worktreeBaseRef: cfg.worktree?.baseRef,
    jsonSchema: cfg.jsonSchema,
    schemaFile: cfg.schemaFile,
    startedAt: Date.now(),
    pending: new Map(),
  };
  byLaunchId.set(launchId, session);

  // Assigned synchronously by the Promise executor below.
  let resolveId!: (id: string) => void;
  let rejectId!: (err: Error) => void;
  const sessionId = new Promise<string>((resolve, reject) => {
    resolveId = resolve;
    rejectId = reject;
  });
  // Don't leave an unhandled rejection if no caller awaits the id.
  sessionId.catch(() => {});

  // Resume: the id is known up front, so register + persist (status->running)
  // and resolve now. A concurrent sendPrompt then finds the live child at once.
  if (cfg.knownSessionId) {
    bySessionId.set(cfg.knownSessionId, session);
    persistSession(session);
    resolveId(cfg.knownSessionId);
  }

  // Normalize every stream-json line (US-007). Events that arrive before the
  // session_id is known can't satisfy the event table's FK, so they're held
  // until init lands (init is always first in practice, so this is normally
  // empty; for resume the id is already set so nothing queues).
  const pending: NormalizedEvent[] = [];
  const handleLine = (raw: string): void => {
    const parsed = parseStreamMessage(raw);
    if (!parsed) return;

    if (parsed.sessionId && !session.sessionId) {
      session.sessionId = parsed.sessionId;
      if (parsed.model && !session.model) session.model = parsed.model;
      bySessionId.set(parsed.sessionId, session);
      persistSession(session);
      resolveId(parsed.sessionId);
    }

    const sid = session.sessionId;
    if (!sid) {
      if (parsed.event) pending.push(parsed.event);
      return;
    }
    while (pending.length) persistEvent(sid, pending.shift() as NormalizedEvent);
    if (parsed.event) {
      trackPermission(session, parsed.event);
      persistEvent(sid, parsed.event);
      // US-044: capture + validate the structured output off the final result.
      if (parsed.event.streamType === "result") {
        captureStructuredResult(session, parsed.event.payload);
      }
    }
    if (parsed.usage) applyUsage(sid, parsed.usage);
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  });
  // Flush a trailing line that wasn't newline-terminated before EOF.
  child.stdout.on("end", () => {
    if (buffer.length) {
      handleLine(buffer);
      buffer = "";
    }
  });

  const cleanup = () => {
    byLaunchId.delete(launchId);
    // Only drop the bySessionId entry if it still points at *this* child; a
    // resume may have replaced it with a fresh process for the same id.
    if (session.sessionId && bySessionId.get(session.sessionId) === session) {
      bySessionId.delete(session.sessionId);
    }
    // Remove the schema temp file we wrote for --json-schema (US-044).
    if (session.schemaFile) {
      try {
        fs.unlinkSync(session.schemaFile);
      } catch {
        // Already gone — nothing to do.
      }
      session.schemaFile = undefined;
    }
  };
  child.on("error", (err) => {
    cleanup();
    rejectId(err);
  });
  child.on("exit", () => {
    cleanup();
    // If init never arrived the id promise is still pending; reject it. After
    // a normal run (or a resume) the promise already resolved, so this is a
    // no-op.
    rejectId(new Error("session exited before system/init"));
  });

  return { launchId, child, sessionId, worktree };
}

/**
 * Start a headless Claude Code session (US-006). Spawns the stream-json CLI,
 * tracks the child handle, captures the session_id from system/init, and
 * upserts the session row. Returns immediately with a promise for the id.
 *
 * With `worktree` set (US-043) the session is run in a fresh git worktree cut
 * off the requested cwd's repo, so parallel driven runs don't collide; the
 * worktree path + base ref are surfaced on the session row and the result.
 */
export function startSession(opts: StartSessionOptions = {}): StartSessionResult {
  let cwd = opts.cwd ?? PACKAGE_ROOT;
  let worktree: WorktreeInfo | undefined;
  if (opts.worktree) {
    worktree = createWorktree(cwd, opts.worktreeRef);
    cwd = worktree.path;
  }
  // US-044: a plausible schema is written to a temp file and constrains output;
  // a missing/malformed one leaves the launch (and the row) at its defaults.
  const schemaFile = writeSchemaFile(opts.jsonSchema);
  return launch(buildArgs({ ...opts, cwd }, schemaFile), {
    cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    worktree,
    jsonSchema: schemaFile ? opts.jsonSchema : undefined,
    schemaFile,
  });
}

/** Encode one user turn as a stream-json input line and write it to stdin. */
function writeUserMessage(child: ChildProcessWithoutNullStreams, text: string): void {
  const msg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  child.stdin.write(JSON.stringify(msg) + "\n");
}

export interface ResumeSessionOptions {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  /** Effort level passed via --effort (low|medium|high|xhigh|max); unset = CLI default. */
  effort?: string;
  /** Pass --fork-session so the resumed run gets a fresh session id (US-042). */
  forkSession?: boolean;
  bare?: boolean;
  /** Optional prompt to deliver over stdin right after relaunch. */
  prompt?: string;
}

/**
 * Resume a dormant session (US-008): relaunch `claude -p --resume <id>` with
 * the same stream-json input/output contract as a fresh start and re-attach
 * the event stream. The cwd is reused from the stored session row unless
 * overridden. Any `prompt` is delivered over stdin once the child is up.
 */
export function resumeSession(
  sessionId: string,
  opts: ResumeSessionOptions = {},
): StartSessionResult {
  let cwd = opts.cwd;
  if (!cwd) {
    const row = getDb()
      .prepare("SELECT cwd FROM session WHERE id = ?")
      .get(sessionId) as { cwd?: string } | undefined;
    cwd = row?.cwd ?? PACKAGE_ROOT;
  }

  const args = [
    "-p",
    "--resume",
    sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (isValidEffort(opts.effort)) args.push("--effort", opts.effort);
  if (opts.forkSession) args.push("--fork-session");
  if (opts.bare) args.push("--bare");

  const result = launch(args, {
    cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    // --fork-session mints a fresh session id, so don't pin the old one; let the
    // new id be captured from system/init like a normal start.
    knownSessionId: opts.forkSession ? undefined : sessionId,
  });
  if (opts.prompt !== undefined) writeUserMessage(result.child, opts.prompt);
  return result;
}

export interface SendPromptResult {
  sessionId: string;
  /** true when the session was dormant and had to be relaunched with --resume. */
  resumed: boolean;
}

/**
 * Send a follow-up prompt to a session (US-008). Routes to the live process's
 * stdin when one is tracked; otherwise relaunches the session with --resume and
 * delivers the prompt over the fresh stream.
 */
export async function sendPrompt(
  sessionId: string,
  text: string,
): Promise<SendPromptResult> {
  const live = bySessionId.get(sessionId);
  if (live && !live.child.killed && live.child.stdin.writable) {
    writeUserMessage(live.child, text);
    getDb()
      .prepare("UPDATE session SET last_activity = ?, status = 'running' WHERE id = ?")
      .run(Date.now(), sessionId);
    return { sessionId, resumed: false };
  }
  const result = resumeSession(sessionId, { prompt: text });
  const sid = await result.sessionId;
  return { sessionId: sid, resumed: true };
}

export interface StopSessionResult {
  /** Whether a live child process was found and signalled. */
  stopped: boolean;
  /**
   * Teardown outcome for a worktree-isolated session (US-043): true/false when
   * removal was attempted, null when there was nothing to remove or it wasn't
   * requested.
   */
  worktreeRemoved: boolean | null;
}

/**
 * Stop a session (US-008): terminate the tracked child (if any) and mark the
 * session row idle. Map cleanup is handled by the child's exit handler.
 *
 * With `removeWorktree:true` (US-043) and a worktree-isolated session, the
 * worktree is also torn down with `git worktree remove --force` after the child
 * is signalled, and its path/base-ref are cleared from the row.
 */
export function stopSession(
  sessionId: string,
  opts: { removeWorktree?: boolean } = {},
): StopSessionResult {
  const live = bySessionId.get(sessionId);
  if (live) {
    try {
      live.child.kill();
    } catch {
      // Already gone — the exit handler will reconcile the maps.
    }
  }
  getDb()
    .prepare("UPDATE session SET status = 'idle', last_activity = ? WHERE id = ?")
    .run(Date.now(), sessionId);

  let worktreeRemoved: boolean | null = null;
  if (opts.removeWorktree) {
    const row = getDb()
      .prepare("SELECT worktree_path FROM session WHERE id = ?")
      .get(sessionId) as { worktree_path?: string | null } | undefined;
    const wt = row?.worktree_path;
    if (wt) {
      worktreeRemoved = removeWorktree(wt);
      if (worktreeRemoved) {
        getDb()
          .prepare(
            "UPDATE session SET worktree_path = NULL, worktree_base_ref = NULL WHERE id = ?",
          )
          .run(sessionId);
      }
    }
  }
  return { stopped: Boolean(live), worktreeRemoved };
}

/**
 * Fold a parsed control event into the session's pending-permission map: a
 * can_use_tool request opens a prompt; a cancel request closes one (US-012).
 */
function trackPermission(session: ManagedSession, ev: NormalizedEvent): void {
  const p = (ev.payload ?? null) as Record<string, unknown> | null;
  const requestId = p && typeof p.request_id === "string" ? p.request_id : null;
  if (ev.streamType === "control_request:can_use_tool" && requestId) {
    session.pending.set(requestId, {
      requestId,
      toolName: ev.toolName,
      input: p?.input,
      ts: Date.now(),
    });
  } else if (ev.streamType === "control_cancel_request" && requestId) {
    session.pending.delete(requestId);
  }
}

/** Every open permission prompt across live sessions (US-012; feeds US-013). */
export interface SessionPermission extends PendingPermission {
  sessionId: string;
}
export function listPendingPermissions(): SessionPermission[] {
  const out: SessionPermission[] = [];
  for (const s of byLaunchId.values()) {
    if (!s.sessionId) continue;
    for (const p of s.pending.values()) out.push({ sessionId: s.sessionId, ...p });
  }
  return out;
}

export interface PermissionDecision {
  decision: "allow" | "deny";
  /** Replacement tool input applied when allowing; defaults to the original. */
  updatedInput?: Record<string, unknown>;
  /** Reason surfaced to the agent when denying. */
  message?: string;
}

/**
 * Answer a tool-permission prompt (US-012) by writing a stream-json
 * control_response to the live child's stdin — the mechanism the headless CLI
 * blocks on. `requestId` matches the control_request; when omitted and exactly
 * one prompt is open, that one is used. Returns whether a live child received
 * the response and the request id that was resolved.
 */
export function decidePermission(
  sessionId: string,
  requestId: string | null,
  decision: PermissionDecision,
): { delivered: boolean; requestId: string | null } {
  const live = bySessionId.get(sessionId);

  // Resolve the target request: explicit id, else the only open prompt.
  let rid = requestId;
  if (!rid && live && live.pending.size === 1) {
    rid = [...live.pending.keys()][0] ?? null;
  }
  const open = rid && live ? live.pending.get(rid) : undefined;

  const result =
    decision.decision === "allow"
      ? {
          behavior: "allow" as const,
          updatedInput: decision.updatedInput ?? (open?.input as object) ?? {},
        }
      : {
          behavior: "deny" as const,
          message: decision.message ?? "Denied by operator",
        };

  if (!live || live.child.killed || !live.child.stdin.writable) {
    if (rid && live) live.pending.delete(rid);
    return { delivered: false, requestId: rid };
  }

  live.child.stdin.write(
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: rid, response: result },
    }) + "\n",
  );
  if (rid) live.pending.delete(rid);
  getDb()
    .prepare("UPDATE session SET last_activity = ?, status = 'running' WHERE id = ?")
    .run(Date.now(), sessionId);
  return { delivered: true, requestId: rid };
}
