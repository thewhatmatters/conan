import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import { HOME } from "../paths.js";

/**
 * Session-liveness reaper (US-001).
 *
 * Headless `claude -p` runs that are killed never fire Stop/SessionEnd, so their
 * session row is frozen at status='running' forever — the dashboard then claims
 * dozens of "active" sessions when zero are alive. This module reconciles the
 * session table against ground truth and garbage-collects obviously-dead rows.
 *
 * Ground truth for "alive":
 *  - a per-live-process marker file at ~/.claude/sessions/<pid>.json whose pid
 *    is still a running process (the file's updatedAt FREEZES when idle, so it
 *    is NOT a heartbeat — liveness = file present AND pid alive), OR
 *  - a session whose last_activity falls inside a recent window (default 5 min),
 *    which also covers Conan-driven sessions whose child we still hold open.
 */

/** Default directory holding Claude Code's per-process session markers. */
const SESSIONS_DIR = path.join(HOME, ".claude", "sessions");

/** Recent-activity window: a row touched this recently still counts as alive. */
const DEFAULT_WINDOW_MS = 5 * 60_000;

/** How often the always-on reaper reconciles the table. */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Synthetic ids left behind by tests/verification runs (e.g. 'sess-abc',
 * 'demo-1', 'sess-demo-018'). These are never real Claude Code session_ids
 * (which are UUIDs) so they're safe to GC outright when not live.
 */
const SYNTHETIC_ID = /^(sess|demo|test|fake|sample|fixture)[-_]/i;

/** A marker file under ~/.claude/sessions (fields we rely on). */
interface SessionMarker {
  pid?: number;
  sessionId?: string;
}

/**
 * Does a process with this pid currently exist? `kill(pid, 0)` sends no signal
 * but performs the permission/existence check: it throws ESRCH when the process
 * is gone and EPERM when it exists but isn't ours (still alive).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Set of session_ids backed by a live process, read from the marker directory.
 * A marker whose pid is dead (or whose file is unreadable) contributes nothing.
 */
export function readLiveSessionIds(dir: string = SESSIONS_DIR): Set<string> {
  const live = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return live; // directory absent on a fresh machine — nothing is live
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let marker: SessionMarker;
    try {
      marker = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as SessionMarker;
    } catch {
      continue;
    }
    const pid =
      typeof marker.pid === "number"
        ? marker.pid
        : Number(file.replace(/\.json$/, ""));
    const sid = typeof marker.sessionId === "string" ? marker.sessionId : null;
    if (sid && isPidAlive(pid)) live.add(sid);
  }
  return live;
}

export interface ReaperOptions {
  /** Recent-activity window in ms (default 5 min). */
  windowMs?: number;
  /** Injectable clock for tests. */
  now?: number;
  /**
   * Pre-computed live session_ids. When omitted, read from the marker dir.
   */
  liveIds?: Set<string>;
}

export interface ReapResult {
  /** Rows transitioned from a stale 'running' to 'dormant'. */
  demoted: number;
  /** Obviously-dead synthetic/empty rows deleted. */
  gced: number;
  /** Sessions still considered active after reconciliation. */
  active: number;
}

interface ReapRow {
  id: string;
  status: string;
  last_activity: number;
  created_at: number;
  event_count: number;
}

/**
 * Reconcile the session table against ground truth in one transaction:
 *  - GC synthetic test rows, and any event-less, dead, aged-out row;
 *  - demote a 'running' row to 'dormant' when it is neither live nor recent;
 *  - return the count of sessions that remain truly active.
 */
export function reconcileSessions(opts: ReaperOptions = {}): ReapResult {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const cutoff = now - windowMs;

  // Liveness comes from Claude Code's per-process marker files (US-003 removed
  // the driven-child path, so there are no in-process sessions to union in).
  const live = opts.liveIds ?? readLiveSessionIds();

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.status, s.last_activity, s.created_at,
              (SELECT COUNT(*) FROM event e WHERE e.session_id = s.id) AS event_count
         FROM session s`,
    )
    .all() as ReapRow[];

  const del = db.prepare("DELETE FROM session WHERE id = ?");
  const demote = db.prepare(
    "UPDATE session SET status = 'dormant' WHERE id = ?",
  );

  let demoted = 0;
  let gced = 0;
  let active = 0;

  db.transaction(() => {
    for (const r of rows) {
      const isLive = live.has(r.id);
      const recent = r.last_activity >= cutoff;

      // GC: synthetic ids, or event-less rows that are dead and aged out.
      const aged = r.created_at < cutoff && r.last_activity < cutoff;
      if (
        !isLive &&
        (SYNTHETIC_ID.test(r.id) || (r.event_count === 0 && aged))
      ) {
        del.run(r.id);
        gced++;
        continue;
      }

      if (isLive || recent) {
        active++;
        continue;
      }

      // Not live and not recent: a frozen 'running' becomes terminal.
      if (r.status === "running") {
        demote.run(r.id);
        demoted++;
      }
    }
  })();

  return { demoted, gced, active };
}

/**
 * Start the always-on reaper: reconcile once immediately (so a stale table is
 * fixed at boot) then on an interval. Returns a stop function. The interval is
 * unref'd so it never keeps the process alive on its own. `onTick` lets other
 * periodic reconciliation (the correlation-health guard, 1.0.2 US-004) ride
 * this cadence instead of owning a timer; it runs after each reconcile and its
 * errors are contained the same way.
 */
export function startReaper(
  options: { windowMs?: number; intervalMs?: number; onTick?: () => void } = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const run = () => {
    try {
      reconcileSessions({ windowMs: options.windowMs });
    } catch (err) {
      console.warn(`[conan] reaper error: ${(err as Error).message}`);
    }
    try {
      options.onTick?.();
    } catch (err) {
      console.warn(`[conan] reaper onTick error: ${(err as Error).message}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
