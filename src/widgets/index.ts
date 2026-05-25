// US-022: data source for the opt-in "secondary widgets" backlog. These are the
// deeper signals deferred from the phase-1 hero row — surfaced only when a user
// turns them on, so the default view stays uncluttered.
//
// One read helper assembles every secondary signal for a given session:
//   - mcp        MCP servers (name + health) from the session's system/init
//   - plugins    plugins loaded + plugin_errors from system/init
//   - topTools   most-used tools by PostToolUse count (hook path, US-004)
//   - apiRetry   api_retry occurrences + per-hour rate over the session's life
//   - git        branch + dirty-file count for the session's cwd
//
// The model + idle widget is derived client-side from the session row (model,
// status, last_activity) and needs no extra data here.
//
// Pure-ish reads (db + a short-lived git child); no broadcasting, so the gateway
// route is a thin wrapper.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { getDb } from "../db/index.js";

/** An MCP server entry as surfaced from system/init. */
export interface McpServer {
  name: string;
  status: string;
}

/** Git status for a session's working directory. */
export interface GitStatus {
  /** true when the cwd is inside a git work tree we could read. */
  available: boolean;
  branch: string | null;
  /** Count of dirty (modified/untracked/staged) paths from `status --porcelain`. */
  dirty: number;
}

/** The full secondary-widget payload for one session. */
export interface WidgetData {
  /** null when the session has no system/init event (hook-only session). */
  mcp: McpServer[] | null;
  /** null when no system/init; otherwise loaded-plugin count + names. */
  plugins: { count: number; names: string[] } | null;
  /** Count of plugin load errors from system/init. */
  pluginErrors: number;
  /** Tools sorted by PostToolUse invocation count, descending. */
  topTools: { name: string; count: number }[];
  /** api_retry occurrences and a per-hour rate over the session's lifetime. */
  apiRetry: { count: number; perHour: number };
  git: GitStatus;
}

/** Latest system/init payload for a session, parsed, or null if none exists. */
function latestInit(sessionId: string): Record<string, unknown> | null {
  const row = getDb()
    .prepare(
      `SELECT payload FROM event
         WHERE session_id = ? AND stream_type = 'system/init'
         ORDER BY ts DESC LIMIT 1`,
    )
    .get(sessionId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Normalize the mcp_servers field (array of {name,status}) into McpServer[]. */
function parseMcp(init: Record<string, unknown> | null): McpServer[] | null {
  if (!init) return null;
  const raw = init.mcp_servers;
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      name: typeof o.name === "string" ? o.name : "unknown",
      status: typeof o.status === "string" ? o.status : "unknown",
    };
  });
}

/** Normalize the plugins field; entries may be strings or {name} objects. */
function parsePlugins(
  init: Record<string, unknown> | null,
): { count: number; names: string[] } | null {
  if (!init) return null;
  const raw = init.plugins;
  if (!Array.isArray(raw)) return { count: 0, names: [] };
  const names = raw.map((p) => {
    if (typeof p === "string") return p;
    const o = (p ?? {}) as Record<string, unknown>;
    return typeof o.name === "string" ? o.name : "unknown";
  });
  return { count: names.length, names };
}

/** Count plugin_errors entries from system/init. */
function countPluginErrors(init: Record<string, unknown> | null): number {
  if (!init) return 0;
  return Array.isArray(init.plugin_errors) ? init.plugin_errors.length : 0;
}

/**
 * Most-used tools for a session by PostToolUse count. The US-004 hook path
 * writes one event per tool completion (hook_event_name='PostToolUse',
 * tool_name set), which is the cleanest invocation signal.
 */
function topTools(sessionId: string): { name: string; count: number }[] {
  return getDb()
    .prepare(
      `SELECT tool_name AS name, COUNT(*) AS count
         FROM event
         WHERE session_id = ?
           AND hook_event_name = 'PostToolUse'
           AND tool_name IS NOT NULL
         GROUP BY tool_name
         ORDER BY count DESC, name ASC
         LIMIT 8`,
    )
    .all(sessionId) as { name: string; count: number }[];
}

/**
 * api_retry occurrences for a session plus a per-hour rate. Retries are emitted
 * by the stream parser as system/api_retry events; the rate normalizes the
 * count over the elapsed session lifetime (created_at → last_activity).
 */
function apiRetryRate(sessionId: string): { count: number; perHour: number } {
  const count = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM event
           WHERE session_id = ? AND stream_type = 'system/api_retry'`,
      )
      .get(sessionId) as { n: number }
  ).n;
  const span = getDb()
    .prepare("SELECT created_at, last_activity FROM session WHERE id = ?")
    .get(sessionId) as
    | { created_at: number; last_activity: number }
    | undefined;
  let perHour = 0;
  if (count > 0 && span) {
    const hours = Math.max(span.last_activity - span.created_at, 60_000) / 3_600_000;
    perHour = count / hours;
  }
  return { count, perHour: Math.round(perHour * 10) / 10 };
}

/** Run `git` in a cwd, returning trimmed stdout or null on any failure. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 2000, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim()),
    );
  });
}

/** Branch + dirty-file count for a session's cwd (US-022 git widget). */
async function gitStatus(cwd: string | null): Promise<GitStatus> {
  const none: GitStatus = { available: false, branch: null, dirty: 0 };
  if (!cwd || !fs.existsSync(cwd)) return none;
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch == null) return none; // not a git work tree (or git missing)
  const porcelain = await git(cwd, ["status", "--porcelain"]);
  const dirty = porcelain ? porcelain.split("\n").filter((l) => l.length).length : 0;
  return { available: true, branch, dirty };
}

/** Assemble the full secondary-widget payload for one session. */
export async function readWidgets(sessionId: string): Promise<WidgetData> {
  const init = latestInit(sessionId);
  const row = getDb()
    .prepare("SELECT cwd FROM session WHERE id = ?")
    .get(sessionId) as { cwd?: string } | undefined;
  return {
    mcp: parseMcp(init),
    plugins: parsePlugins(init),
    pluginErrors: countPluginErrors(init),
    topTools: topTools(sessionId),
    apiRetry: apiRetryRate(sessionId),
    git: await gitStatus(row?.cwd ?? null),
  };
}
