import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { isPidAlive } from "../session/reaper.js";

/**
 * Correlate a pty to the Claude Code session running inside it (US-036).
 *
 * The dock's terminals launch `claude` through a login shell, so the live
 * `claude` process is a *descendant* of the pty's child pid. Claude Code writes
 * a per-process marker at ~/.claude/sessions/<pid>.json carrying that pid, its
 * sessionId, cwd, and — once the user runs /rename — a `name`. We map a pty back
 * to its session by finding which live marker's pid sits under the pty pid, so
 * the Term ▾ dropdown can label tabs by their session ("Conan:ca7cb3a8") instead
 * of the positional "Term N".
 *
 * Claude Code 2.1.173 stopped writing those markers for interactive sessions
 * (gated off behind a statsig flag), so markers alone went dark (1.0.2 US-003).
 * The marker path stays primary, but when it yields nothing we fall back to the
 * hook-reported pid: every hook event carries the live `claude` pid (US-001),
 * the gateway persists it on `session.claude_pid` (US-002), and here we match
 * the pty's descendant pids against those known session pids. cwd+recency stays
 * the LAST resort — it mis-binds two tabs running in the same directory.
 */

/** Default directory holding Claude Code's per-process session markers. */
const SESSIONS_DIR = path.join(HOME, ".claude", "sessions");

/** The marker fields we rely on. */
interface SessionMarker {
  pid?: number;
  sessionId?: string;
  name?: string;
  cwd?: string;
  startedAt?: number;
}

/** What a successful correlation yields: the session id and its /renamed name. */
export interface ClaudeSessionInfo {
  sessionId: string;
  /** The /renamed session name, or null when never renamed. */
  name: string | null;
}

/**
 * A recent session row from the gateway DB, fed to the marker-independent
 * fallback (1.0.2 US-003). `claudePid` is the hook-reported live claude process
 * pid (US-001/US-002); rows where it's null can't pid-match or prove liveness,
 * so the lookup may simply omit them.
 */
export interface SessionPidCandidate {
  sessionId: string;
  claudePid: number | null;
  cwd: string | null;
  lastActivity: number;
}

/** Supplies recent DB sessions to {@link correlateClaudeSession}. */
export type SessionCandidateLookup = () => SessionPidCandidate[];

/**
 * The wired DB lookup. Kept injected (rather than importing the DB here) so
 * correlation stays unit-testable with a synthetic candidate list; the terminal
 * module wires the real query at import time. Until wired: no candidates.
 */
let sessionCandidateLookup: SessionCandidateLookup = () => [];

/** Wire (or override, in tests) the DB-backed session candidate lookup. */
export function setSessionCandidateLookup(fn: SessionCandidateLookup): void {
  sessionCandidateLookup = fn;
}

/**
 * Read every session marker (live or not). Unreadable/corrupt files contribute
 * nothing. Each entry carries the marker's own data plus the pid it represents.
 */
function readMarkers(dir: string): SessionMarker[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionMarker[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let marker: SessionMarker;
    try {
      marker = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8"),
      ) as SessionMarker;
    } catch {
      continue;
    }
    const pid =
      typeof marker.pid === "number"
        ? marker.pid
        : Number(file.replace(/\.json$/, ""));
    if (Number.isInteger(pid) && pid > 0) out.push({ ...marker, pid });
  }
  return out;
}

/**
 * Build a parent→children pid map from `ps`. Returns an empty map when `ps` is
 * unavailable (correlation then degrades to the cwd fallback). The `comm`-less
 * `pid=,ppid=` form keeps the output two clean numeric columns.
 */
function processChildren(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return children;
  }
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const kids = children.get(ppid);
    if (kids) kids.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/** All transitive descendant pids of `root` (excluding `root` itself). */
function descendantsOf(root: number, children: Map<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const kid of children.get(pid) ?? []) stack.push(kid);
  }
  return seen;
}

/** Normalize a marker into the public shape (drops blank names). */
function toInfo(m: SessionMarker): ClaudeSessionInfo | null {
  if (typeof m.sessionId !== "string" || !m.sessionId) return null;
  const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : null;
  return { sessionId: m.sessionId, name };
}

/**
 * Correlate one pty (its child pid + spawned cwd) to a live Claude session.
 *
 * Order of evidence, strongest first:
 * 1. A live marker whose pid is a descendant of the pty — exact structural match.
 * 2. A recent DB session whose hook-reported `claude_pid` is alive AND a
 *    descendant of the pty (1.0.2 US-003) — equally structural, marker-free.
 *    Freshest session first: a /clear reuses the same claude process for a new
 *    session id, and the live one keeps bumping `last_activity`.
 * 3. cwd + recency, markers then DB candidates — LAST because it mis-binds two
 *    tabs running in the same directory; it only fires with no pid evidence at
 *    all (e.g. `ps` unavailable, or hooks not yet reporting).
 * Returns null when nothing live correlates.
 */
export function correlateClaudeSession(
  ptyPid: number,
  cwd: string,
  dir: string = SESSIONS_DIR,
  lookup: SessionCandidateLookup = sessionCandidateLookup,
): ClaudeSessionInfo | null {
  const markers = readMarkers(dir).filter((m) => isPidAlive(m.pid!));
  // Both expensive inputs are lazy: the ps tree walk runs at most once per call,
  // and the DB lookup + per-candidate liveness probes only when markers miss.
  let descendants: Set<number> | null = null;
  const ptyDescendants = () =>
    (descendants ??= descendantsOf(ptyPid, processChildren()));
  let candidates: SessionPidCandidate[] | null = null;
  const liveCandidates = () =>
    (candidates ??= lookup()
      .filter(
        (c) =>
          typeof c.claudePid === "number" &&
          Number.isInteger(c.claudePid) &&
          c.claudePid > 0 &&
          isPidAlive(c.claudePid),
      )
      .sort((a, b) => b.lastActivity - a.lastActivity));

  // 1. Primary: the live marker whose pid is a descendant of the pty.
  for (const m of markers) {
    if (ptyDescendants().has(m.pid!)) {
      const info = toInfo(m);
      if (info) return info;
    }
  }

  // 2. Marker-independent: hook-reported claude pids of recent sessions.
  for (const c of liveCandidates()) {
    if (ptyDescendants().has(c.claudePid!)) {
      return { sessionId: c.sessionId, name: null };
    }
  }

  // 3. Last resort: same-cwd, most recent first — markers, then DB candidates.
  const sameCwd = markers
    .filter((m) => m.cwd === cwd)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const m of sameCwd) {
    const info = toInfo(m);
    if (info) return info;
  }
  for (const c of liveCandidates()) {
    if (c.cwd === cwd) return { sessionId: c.sessionId, name: null };
  }
  return null;
}

/** First 8 chars of a session id, the short form shown in the dropdown. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * The current working directory of a live process, looked up from the OS by pid
 * (US-003) — the polling fallback for shells that don't emit OSC 7. Same family
 * of OS process inspection {@link correlateClaudeSession} uses (`ps` for the
 * pid tree): here we read the pty child's cwd directly. On Linux we read the
 * `/proc/<pid>/cwd` symlink; elsewhere (macOS/BSD) we ask `lsof` for the
 * process's cwd file descriptor in machine-readable form (`-Fn` → an `n<path>`
 * line). Returns null when the lookup fails or yields no absolute path, in which
 * case the caller simply leaves the active cwd as-is.
 */
export function processCwd(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const p = fs.readlinkSync(`/proc/${pid}/cwd`);
      return p.startsWith("/") ? p : null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync(
      "lsof",
      ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    for (const line of out.split("\n")) {
      if (!line.startsWith("n")) continue;
      const p = line.slice(1).trim();
      if (p.startsWith("/")) return p;
    }
  } catch {
    /* lsof unavailable, or the pid is gone — degrade to no-op */
  }
  return null;
}
