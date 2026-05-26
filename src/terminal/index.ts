import crypto from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { getDb } from "../db/index.js";
import { getActiveCwd } from "../cwd/index.js";
import { correlateClaudeSession, shortSessionId } from "./correlate.js";

const DEFAULT_SHELL =
  process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

/** The `claude` binary to auto-launch; override with CONAN_CLAUDE_BIN. */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/**
 * Ring-buffer cap per terminal session (US-017). Recent pty output is held so a
 * reconnecting client can replay what it missed; oldest chunks are evicted once
 * the cap is exceeded. Override with CONAN_TERM_RING_BYTES (used by tests).
 */
const RING_MAX_BYTES = clampEnvInt("CONAN_TERM_RING_BYTES", 256 * 1024, 1, 64 * 1024 * 1024);

/**
 * How long a pty survives after its client disconnects, so a reconnect can
 * re-attach and replay (US-017/US-018). Only sessions the client opted into
 * (by passing a stable `tid`) survive; anonymous ones die on close as before.
 * Override with CONAN_TERM_GRACE_MS (used by tests).
 */
const DETACH_GRACE_MS = clampEnvInt("CONAN_TERM_GRACE_MS", 30_000, 0, 60 * 60_000);

/**
 * Resolve what the pty runs. `mode=claude` (default) launches Claude Code so the
 * terminal *is* a Claude session; `mode=shell` drops to a plain shell.
 * For claude we go through a login shell so PATH/nvm/aliases resolve, and fall
 * back to an interactive shell when claude exits (so the dock stays usable).
 */
function resolveCommand(mode: string): { file: string; args: string[] } {
  if (mode === "shell") return { file: DEFAULT_SHELL, args: [] };
  return {
    file: DEFAULT_SHELL,
    args: ["-l", "-c", `${CLAUDE_BIN}; exec ${DEFAULT_SHELL} -i`],
  };
}

/** Build a clean string env for the pty (drops undefined values). */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

interface ClientMessage {
  type: "input" | "resize" | "close";
  data?: string;
  cols?: number;
  rows?: number;
}

/**
 * A live pty plus its replay ring buffer. The pty + its onData/onExit listeners
 * are created once and outlive any single WebSocket; `ws` is the currently
 * attached client (or null while detached during the grace window).
 */
interface TermSession {
  id: string;
  term: pty.IPty;
  /** The cwd the pty was spawned in — used to correlate it to a session (US-036). */
  cwd: string;
  /** Recent output chunks, capped to RING_MAX_BYTES (oldest evicted). */
  buffer: string[];
  bufferBytes: number;
  /** Currently attached client socket, or null while detached. */
  ws: WebSocket | null;
  /** True when the client passed a stable `tid` and wants the pty to survive. */
  persistent: boolean;
  /** Pending kill scheduled after a detach; cleared on reattach. */
  killTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  onData: pty.IDisposable;
  onExit: pty.IDisposable;
}

/** Live terminal sessions keyed by their id (the client-supplied `tid`, or a UUID). */
const sessions = new Map<string, TermSession>();

/**
 * Attach a node-pty session to an (already authenticated) WebSocket (US-015).
 * If the client passes a `tid` matching a still-live session, the buffered
 * backlog is replayed before live streaming resumes (US-017); otherwise a fresh
 * pty is spawned. Output frames are sent raw; the client sends JSON control
 * frames ({type:'input'|'resize'}).
 */
export function attachTerminal(ws: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const tid = url.searchParams.get("tid");

  // --- Reconnect path: re-attach to a surviving pty and replay its backlog ---
  if (tid) {
    const existing = sessions.get(tid);
    if (existing && !existing.exited) {
      reattach(existing, ws);
      return;
    }
  }

  // --- Fresh session ---------------------------------------------------------
  const cols = clampInt(url.searchParams.get("cols"), 80, 1, 1000);
  const rows = clampInt(url.searchParams.get("rows"), 24, 1, 1000);
  // New ptys spawn in the app-wide active cwd (US-019); an explicit ?cwd= still
  // wins. Already-running ptys keep the cwd they were spawned with.
  const cwd = url.searchParams.get("cwd") ?? getActiveCwd();
  const mode = url.searchParams.get("mode") ?? "claude";
  const { file, args } = resolveCommand(mode);

  const id = tid ?? crypto.randomUUID();
  let term: pty.IPty;
  try {
    term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: ptyEnv(),
    });
  } catch (err) {
    ws.send(`\r\n[conan] failed to start terminal: ${(err as Error).message}\r\n`);
    ws.close();
    return;
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO terminal_session (id, session_id, pid, cols, rows, created_at)
     VALUES (?, NULL, ?, ?, ?, ?)`,
  ).run(id, term.pid, cols, rows, Date.now());

  const session: TermSession = {
    id,
    term,
    cwd,
    buffer: [],
    bufferBytes: 0,
    ws: null,
    persistent: tid !== null,
    killTimer: null,
    exited: false,
    onData: { dispose() {} },
    onExit: { dispose() {} },
  };
  sessions.set(id, session);

  // onData/onExit are wired once and persist across reattaches; they forward to
  // whatever client is currently attached and always feed the ring buffer.
  session.onData = term.onData((d) => {
    pushBuffer(session, d);
    if (session.ws && session.ws.readyState === session.ws.OPEN) session.ws.send(d);
  });
  session.onExit = term.onExit(({ exitCode }) => {
    session.exited = true;
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(`\r\n[conan] process exited (${exitCode})\r\n`);
      session.ws.close();
    }
    destroySession(session);
  });

  attach(session, ws);
}

/** Cap the ring buffer to RING_MAX_BYTES, evicting oldest chunks first. */
function pushBuffer(s: TermSession, chunk: string): void {
  s.buffer.push(chunk);
  s.bufferBytes += Buffer.byteLength(chunk);
  while (s.bufferBytes > RING_MAX_BYTES && s.buffer.length > 1) {
    const evicted = s.buffer.shift()!;
    s.bufferBytes -= Buffer.byteLength(evicted);
  }
}

/** Re-attach a surviving session to a new socket, replaying its backlog first. */
function reattach(session: TermSession, ws: WebSocket): void {
  if (session.killTimer) {
    clearTimeout(session.killTimer);
    session.killTimer = null;
  }
  // Drop any stale socket without tearing down the pty.
  if (session.ws && session.ws !== ws) {
    try {
      session.ws.close();
    } catch {
      /* already closing */
    }
  }
  attach(session, ws);
}

/**
 * Wire a socket to a session: replay the buffered backlog (so the client sees
 * what it missed before live output resumes), then point live output at it and
 * handle input/resize/close. Replay is synchronous, so no live chunk can slip
 * in between the backlog and the `ws` assignment.
 */
function attach(session: TermSession, ws: WebSocket): void {
  if (session.buffer.length && ws.readyState === ws.OPEN) {
    ws.send(session.buffer.join(""));
  }
  session.ws = ws;

  const db = getDb();
  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      session.term.write(msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      session.term.resize(msg.cols, msg.rows);
      db.prepare(`UPDATE terminal_session SET cols = ?, rows = ? WHERE id = ?`).run(
        msg.cols,
        msg.rows,
        session.id,
      );
    } else if (msg.type === "close") {
      // Explicit tab close (US-026): kill the pty + drop its DB row now, even for
      // a persistent (tid) session — this is a user action, not a dropped socket,
      // so it must not survive the detach grace window.
      destroySession(session);
    }
  });

  ws.on("close", () => {
    if (session.ws !== ws) return; // a newer socket already took over
    session.ws = null;
    if (session.exited) return; // onExit already cleaned up (or will)
    if (!sessions.has(session.id)) return; // already destroyed (explicit close)
    if (!session.persistent) {
      destroySession(session);
      return;
    }
    // Keep the pty + buffer alive briefly so a reconnect can replay (US-017).
    session.killTimer = setTimeout(() => destroySession(session), DETACH_GRACE_MS);
  });
}

/** Kill the pty, drop listeners, and remove the session + its DB row. */
function destroySession(session: TermSession): void {
  if (!sessions.has(session.id)) return; // already torn down
  sessions.delete(session.id);
  if (session.killTimer) {
    clearTimeout(session.killTimer);
    session.killTimer = null;
  }
  session.onData.dispose();
  session.onExit.dispose();
  try {
    session.term.kill();
  } catch {
    /* already gone */
  }
  getDb().prepare(`DELETE FROM terminal_session WHERE id = ?`).run(session.id);
}

/** Tear down every live terminal session (gateway shutdown). */
export function closeAllTerminals(): void {
  for (const session of [...sessions.values()]) destroySession(session);
}

/** One terminal tab's identity + the Claude session running inside it (US-036). */
export interface TerminalSummary {
  tid: string;
  /** The /renamed session name, or null when unnamed / no live session. */
  name: string | null;
  /** The correlated Claude session id, or null when none is live. */
  sessionId: string | null;
  /** First 8 chars of `sessionId`, for the compact dropdown label. */
  shortId: string | null;
}

/**
 * Summarize every live terminal, correlating each pty to the Claude session
 * running inside it so the Term ▾ dropdown can label tabs by name + short id
 * (US-036). Exited sessions are skipped. Correlation is best-effort: a tab with
 * no live Claude session reports null name/id and the UI falls back to "Term N".
 */
export function listTerminalSessions(): TerminalSummary[] {
  const out: TerminalSummary[] = [];
  for (const s of sessions.values()) {
    if (s.exited) continue;
    const info = correlateClaudeSession(s.term.pid, s.cwd);
    out.push({
      tid: s.id,
      name: info?.name ?? null,
      sessionId: info?.sessionId ?? null,
      shortId: info ? shortSessionId(info.sessionId) : null,
    });
  }
  return out;
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  return clampInt(process.env[name] ?? null, fallback, min, max);
}
