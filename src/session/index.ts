import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getDb } from "../db/index.js";
import { PACKAGE_ROOT } from "../paths.js";
import {
  parseStreamMessage,
  type NormalizedEvent,
  type UsageUpdate,
} from "./parser.js";

/** The `claude` binary to launch headless; override with CONAN_CLAUDE_BIN. */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

export interface StartSessionOptions {
  /** Working directory the agent runs in. Defaults to the repo root. */
  cwd?: string;
  /** Model alias/slug passed via --model (e.g. "sonnet", "opus"). */
  model?: string;
  /** Permission mode passed via --permission-mode (default|acceptEdits|plan|dontAsk). */
  permissionMode?: string;
  /** Append --bare for a reproducible, minimal-config launch. */
  bare?: boolean;
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
  startedAt: number;
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

/**
 * Build the headless argv. Per US-006 the core invocation is
 *   claude -p --output-format stream-json --verbose --include-partial-messages
 * We additionally request stream-json *input* so the process stays alive to
 * receive follow-up prompts (US-008); a one-shot `prompt` is passed positionally.
 */
function buildArgs(opts: StartSessionOptions): string[] {
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
  if (opts.bare) args.push("--bare");
  if (opts.prompt !== undefined) args.push(opts.prompt);
  return args;
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

/** Insert one normalized stream-json event for a known session_id (US-007). */
function persistEvent(sessionId: string, ev: NormalizedEvent): number {
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
      JSON.stringify(ev.payload ?? null),
      Date.now(),
    );
  return Number(info.lastInsertRowid);
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
      `INSERT INTO session (id, cwd, model, permission_mode, status, created_at, last_activity)
         VALUES (@id, @cwd, @model, @permissionMode, 'running', @startedAt, @now)
       ON CONFLICT(id) DO UPDATE SET
         status = 'running',
         last_activity = @now,
         cwd = COALESCE(excluded.cwd, session.cwd),
         model = COALESCE(excluded.model, session.model),
         permission_mode = COALESCE(excluded.permission_mode, session.permission_mode)`,
    )
    .run({
      id: s.sessionId,
      cwd: s.cwd,
      model: s.model ?? null,
      permissionMode: s.permissionMode ?? null,
      startedAt: s.startedAt,
      now,
    });
}

export interface StartSessionResult {
  launchId: string;
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the captured session_id once system/init is seen. */
  sessionId: Promise<string>;
}

/** Internal launch config shared by start (US-006) and resume (US-008). */
interface LaunchConfig {
  cwd: string;
  model?: string;
  permissionMode?: string;
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
    startedAt: Date.now(),
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
    if (parsed.event) persistEvent(sid, parsed.event);
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

  return { launchId, child, sessionId };
}

/**
 * Start a headless Claude Code session (US-006). Spawns the stream-json CLI,
 * tracks the child handle, captures the session_id from system/init, and
 * upserts the session row. Returns immediately with a promise for the id.
 */
export function startSession(opts: StartSessionOptions = {}): StartSessionResult {
  const cwd = opts.cwd ?? PACKAGE_ROOT;
  return launch(buildArgs(opts), {
    cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
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
  if (opts.bare) args.push("--bare");

  const result = launch(args, {
    cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    knownSessionId: sessionId,
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

/**
 * Stop a session (US-008): terminate the tracked child (if any) and mark the
 * session row idle. Returns whether a live child was found. Map cleanup is
 * handled by the child's exit handler.
 */
export function stopSession(sessionId: string): boolean {
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
  return Boolean(live);
}
