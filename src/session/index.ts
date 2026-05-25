import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getDb } from "../db/index.js";
import { PACKAGE_ROOT } from "../paths.js";

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

/** Try to read a Claude Code session_id out of one parsed stream-json line. */
function initSessionId(line: string): string | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
    return m.session_id;
  }
  return null;
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

/**
 * Start a headless Claude Code session (US-006). Spawns the stream-json CLI,
 * tracks the child handle, captures the session_id from system/init, and
 * upserts the session row. Returns immediately with a promise for the id so
 * callers don't block; full stream parsing is US-007, drive/stop is US-008.
 */
export function startSession(opts: StartSessionOptions = {}): StartSessionResult {
  const cwd = opts.cwd ?? PACKAGE_ROOT;
  const launchId = crypto.randomUUID();
  const args = buildArgs(opts);

  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    env: sessionEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const session: ManagedSession = {
    launchId,
    sessionId: null,
    child,
    cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    startedAt: Date.now(),
  };
  byLaunchId.set(launchId, session);

  let resolveId: (id: string) => void;
  let rejectId: (err: Error) => void;
  const sessionId = new Promise<string>((resolve, reject) => {
    resolveId = resolve;
    rejectId = reject;
  });
  // Don't leave an unhandled rejection if no caller awaits the id.
  sessionId.catch(() => {});

  // Minimal line scan for system/init; the full normalizer is US-007.
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (session.sessionId) return; // already captured
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const id = initSessionId(line);
      if (id) {
        session.sessionId = id;
        bySessionId.set(id, session);
        persistSession(session);
        resolveId(id);
        return;
      }
    }
  });

  const cleanup = () => {
    byLaunchId.delete(launchId);
    if (session.sessionId) bySessionId.delete(session.sessionId);
  };
  child.on("error", (err) => {
    cleanup();
    rejectId(err);
  });
  child.on("exit", () => {
    cleanup();
    rejectId(new Error("session exited before system/init"));
  });

  return { launchId, child, sessionId };
}
