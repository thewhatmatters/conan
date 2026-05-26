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
 * Primary: the live marker whose pid is a descendant of the pty pid — an exact
 * structural match. Fallback (no descendant matched, e.g. `ps` unavailable):
 * the most-recently-started *live* marker whose cwd equals the pty's cwd.
 * Returns null when nothing live correlates.
 */
export function correlateClaudeSession(
  ptyPid: number,
  cwd: string,
  dir: string = SESSIONS_DIR,
): ClaudeSessionInfo | null {
  const markers = readMarkers(dir).filter((m) => isPidAlive(m.pid!));
  if (markers.length === 0) return null;

  const descendants = descendantsOf(ptyPid, processChildren());
  for (const m of markers) {
    if (descendants.has(m.pid!)) {
      const info = toInfo(m);
      if (info) return info;
    }
  }

  // Fallback: same-cwd, most recently started live session.
  const sameCwd = markers
    .filter((m) => m.cwd === cwd)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const m of sameCwd) {
    const info = toInfo(m);
    if (info) return info;
  }
  return null;
}

/** First 8 chars of a session id, the short form shown in the dropdown. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
