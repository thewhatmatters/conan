import crypto from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { getDb } from "../db/index.js";
import { getActiveCwd } from "../cwd/index.js";
import { correlateClaudeSession, shortSessionId } from "./correlate.js";
import {
  parseContextFrame,
  cacheCapturedContext,
  getCapturedContext,
} from "../context/index.js";
import {
  shouldAutoRefreshContext,
  getContextGrowth,
  resetContextGrowth,
  CONTEXT_MIN_SPACING_MS,
} from "../context/autorefresh.js";
import { parseUsageFrame, parseUsageSession, cacheCapturedUsage } from "../usage/probe.js";

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
 * Bound on the rolling buffer scanned for a `/context` frame (US-009). A frame
 * fits comfortably in a few KB; we keep a small tail so a frame split across pty
 * chunks still assembles, without re-scanning the whole replay ring.
 */
const CTX_SCAN_MAX = 64 * 1024;

/**
 * Bound on the rolling buffer scanned for a `/usage` frame (US-010). The /usage
 * screen (Session block + 3 windows + the detail section) is larger than
 * /context, so we keep a slightly bigger tail to assemble it across pty chunks.
 */
const USAGE_SCAN_MAX = 96 * 1024;

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
  /** Rolling tail of recent output scanned for a `/context` frame (US-009). */
  ctxScan: string;
  /** Rolling tail of recent output scanned for a `/usage` frame (US-010). */
  usageScan: string;
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
    ctxScan: "",
    usageScan: "",
    exited: false,
    onData: { dispose() {} },
    onExit: { dispose() {} },
  };
  sessions.set(id, session);

  // onData/onExit are wired once and persist across reattaches; they forward to
  // whatever client is currently attached and always feed the ring buffer.
  session.onData = term.onData((d) => {
    pushBuffer(session, d);
    maybeCaptureContext(session, d);
    maybeCaptureUsage(session, d);
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

/**
 * Passive `/context` capture (US-009): accumulate a small tail of the pty's
 * output and, once a frame looks complete (its last row "Free space" has
 * rendered), parse it and cache it under the session correlated to this pty —
 * WITHOUT injecting anything. The user ran /context themselves; we just read it.
 * The "Free space" gate keeps the parse (which strips+collapses the tail) rare.
 * Correlation runs only on a parseable frame, so the per-chunk cost stays low.
 */
function maybeCaptureContext(s: TermSession, chunk: string): void {
  s.ctxScan = (s.ctxScan + chunk).slice(-CTX_SCAN_MAX);
  // Cheap pre-gate: the word "Free" is rare in normal output and (unlike a
  // multi-word phrase) survives the TUI's per-cell ANSI/cursor positioning. Only
  // when it appears do we pay for the ANSI strip + parse. The /context summary
  // (categories + the Free space row) renders BEFORE the long detail listing of
  // every MCP tool/skill, so the Free-space chunk arrives while the summary is
  // still in the scan tail — we capture it then, before the detail scrolls it out.
  if (!s.ctxScan.includes("Free")) return;
  const parsed = parseContextFrame(s.ctxScan);
  // Require the Free-space row: it's /context's last summary line, so its presence
  // means we have a complete frame (not a half-rendered one).
  if (!parsed || !parsed.categories.some((c) => c.key === "free")) return;
  const info = correlateClaudeSession(s.term.pid, s.cwd);
  if (!info?.sessionId) return; // keep scanning; retry on a later chunk
  cacheCapturedContext(info.sessionId, parsed);
  // Reset the scan window so the same lingering frame isn't re-parsed every
  // chunk; a fresh /context run re-accumulates and re-captures.
  s.ctxScan = "";
}

/**
 * On-demand /context refresh (US-009): inject `/context` into the pty running a
 * given session, reusing the keystroke-injection path (answerInteractivePermission).
 * The resulting frame is captured passively by maybeCaptureContext. Returns
 * whether a live correlated pty was found — false falls back to the estimate.
 */
export function injectContextRefresh(sessionId: string): boolean {
  const s = findTermForSession(sessionId);
  if (!s || s.exited) return false;
  try {
    s.term.write("/context\r");
    return true;
  } catch {
    return false;
  }
}

/**
 * Context-pressure compact (US-013): inject `/handoff` into the pty running a
 * given session, reusing the keystroke-injection path. The SESSION authors
 * HANDOFF.md (Conan can't author it — only the live conversation knows its own
 * state); we just type the command so the checkpoint runs before a /compact.
 * Returns whether a live correlated pty was found — false leaves the action a
 * no-op (the UI disables Compact when there's no live pty).
 */
export function injectHandoff(sessionId: string): boolean {
  const s = findTermForSession(sessionId);
  if (!s || s.exited) return false;
  try {
    s.term.write("/handoff\r");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the adaptive /context auto-refresh is enabled (US-006). Defaults from
 * the CONAN_CONTEXT_AUTOREFRESH env var (off only when explicitly "0") but is
 * runtime-settable from the UI's Context-tab "Auto" toggle, so the user owns the
 * observer-effect tradeoff without an env var. Held in gateway memory — resets to
 * the env default on restart.
 */
let contextAutoRefreshEnabled = process.env.CONAN_CONTEXT_AUTOREFRESH !== "0";

/** Current state of the adaptive /context auto-refresh gate (US-006). */
export function getContextAutoRefresh(): boolean {
  return contextAutoRefreshEnabled;
}

/** Turn the adaptive /context auto-refresh gate on/off at runtime (US-006). */
export function setContextAutoRefresh(enabled: boolean): void {
  contextAutoRefreshEnabled = enabled;
}

const lastAutoContextRefresh = new Map<string, number>();

/**
 * Adaptive auto-refresh of `/context` on a turn boundary (the Stop hook) — US-002.
 * Instead of refreshing every turn, the inject (which itself costs ~4-6k tokens)
 * fires only when {@link shouldAutoRefreshContext} says context has likely moved
 * a lot: enough accumulated output since the last capture, bounded by a hard
 * floor (min spacing) and a ceiling (refresh eventually even on small deltas).
 *
 * A passive capture (user ran /context) within the floor also short-circuits —
 * context was just measured, so no inject is needed. No-op when disabled or when
 * the session has no live correlated pty (injectContextRefresh returns false).
 * Returns whether an inject was issued. On a successful inject the per-session
 * output accumulator is reset so the next delta is measured from here.
 */
export function autoRefreshContextOnStop(sessionId: string): boolean {
  if (!contextAutoRefreshEnabled) return false;
  const now = Date.now();
  // A recent passive capture already measured context within the floor window.
  const cap = getCapturedContext(sessionId);
  if (cap && now - cap.capturedAt < CONTEXT_MIN_SPACING_MS) return false;
  const decision = shouldAutoRefreshContext({
    now,
    lastRefreshAt: lastAutoContextRefresh.get(sessionId) ?? 0,
    deltaBytes: getContextGrowth(sessionId),
  });
  if (!decision) return false;
  const issued = injectContextRefresh(sessionId);
  if (issued) {
    lastAutoContextRefresh.set(sessionId, now);
    resetContextGrowth(sessionId);
  }
  return issued;
}

/**
 * Passive `/usage` capture (US-010): accumulate a tail of the pty's output and,
 * once the /usage windows have rendered (a "Resets" line is present), parse the
 * Session block + all three windows and cache them under the correlated session —
 * WITHOUT injecting anything. The user ran /usage themselves; we just read it.
 * The Session block is session-specific, so it can only come from this live pty.
 *
 * The frame renders the Session block + windows BEFORE the long "What's
 * contributing" detail; we re-capture as each window arrives and only clear the
 * scan once the detail section ("contributing") appears, so the final cached
 * frame carries all three windows rather than a half-rendered one.
 */
function maybeCaptureUsage(s: TermSession, chunk: string): void {
  s.usageScan = (s.usageScan + chunk).slice(-USAGE_SCAN_MAX);
  // Cheap pre-gate: "Resets" labels each window's reset line — rare in normal
  // output and present once a window has rendered. Only then pay for the parse.
  if (!s.usageScan.includes("Resets")) return;
  const windows = parseUsageFrame(s.usageScan);
  if (!windows || !windows.fiveHour) return; // not a complete /usage frame yet
  const info = correlateClaudeSession(s.term.pid, s.cwd);
  if (!info?.sessionId) return; // keep scanning; retry on a later chunk
  cacheCapturedUsage(info.sessionId, {
    session: parseUsageSession(s.usageScan),
    fiveHour: windows.fiveHour,
    sevenDay: windows.sevenDay,
    sevenDaySonnet: windows.sevenDaySonnet,
    status: windows.status,
  });
  // Clear only once the frame is fully rendered (the detail section, which comes
  // after every window, has appeared) so we don't drop the later windows.
  if (s.usageScan.includes("contributing")) s.usageScan = "";
}

/**
 * On-demand /usage refresh (US-010): inject `/usage` into the pty running a given
 * session, reusing the keystroke-injection path. The resulting frame is captured
 * passively by maybeCaptureUsage. Returns whether a live correlated pty was found
 * — false falls back to the throwaway-probe windows / token-trend baseline.
 */
export function injectUsageRefresh(sessionId: string): boolean {
  const s = findTermForSession(sessionId);
  if (!s || s.exited) return false;
  try {
    s.term.write("/usage\r");
    return true;
  } catch {
    return false;
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

/** The live pty running a given Claude session (US-009), or null when none. */
function findTermForSession(sessionId: string): TermSession | null {
  for (const s of sessions.values()) {
    if (s.exited) continue;
    const info = correlateClaudeSession(s.term.pid, s.cwd);
    if (info?.sessionId === sessionId) return s;
  }
  return null;
}

/**
 * Claude session ids that have a live, correlated pty (US-009). A permission
 * prompt for one of these is answerable by typing into that terminal even when
 * the session is observed (not driven over stdin). Drives which interactive
 * prompts the pending-approvals list can honestly present.
 */
export function liveTerminalSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions.values()) {
    if (s.exited) continue;
    const info = correlateClaudeSession(s.term.pid, s.cwd);
    if (info?.sessionId) ids.add(info.sessionId);
  }
  return ids;
}

/**
 * Answer an interactive Claude Code permission prompt (US-009) by typing the
 * chosen option into the correlated pty. Claude's TUI renders the choices as a
 * numbered menu, so we send the 1-based option number followed by Enter. Returns
 * whether a live pty was found and written to — best-effort by nature (driving a
 * TUI is brittle), so a `false` return must fall back to the honest
 * non-deliverable state rather than claim success.
 */
export function answerInteractivePermission(
  sessionId: string,
  optionNumber: number,
): boolean {
  const s = findTermForSession(sessionId);
  if (!s || s.exited) return false;
  const n =
    Number.isFinite(optionNumber) && optionNumber >= 1 ? Math.floor(optionNumber) : 1;
  try {
    s.term.write(`${n}\r`);
    return true;
  } catch {
    return false;
  }
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
