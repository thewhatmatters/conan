// US-022 / US-010: data source for the picker-fronted widget area. These are the
// per-session signals the hero widgets surface when a user turns them on.
//
// One read helper assembles every per-session signal for a given session:
//   - mcp        MCP servers (name + health) from the session's system/init
//   - git        branch + dirty-file count for the session's cwd
//
// The model + idle widget is derived client-side from the session row (model,
// status, last_activity) and needs no extra data here. The Plugins, API-retry,
// and Top-tools widgets were dropped in US-010 (they added no value), so their
// reads are gone too.
//
// Pure-ish reads (db + a short-lived git child); no broadcasting, so the gateway
// route is a thin wrapper.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { getDb } from "../db/index.js";
import { readContextUsage, type ContextUsage } from "../transcript/index.js";

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

/** The per-session widget payload for one session. */
export interface WidgetData {
  /** null when the session has no system/init event (hook-only session). */
  mcp: McpServer[] | null;
  git: GitStatus;
  /**
   * Latest assistant turn's context consumption from the transcript (US-013);
   * null when no transcript usage is available (UI falls back to the session's
   * stored context_tokens).
   */
  context: ContextUsage | null;
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

/**
 * Branch + dirty-file count for a working directory (US-022 git widget).
 * Exported so the Git widget can follow the app-wide active cwd (US-019), not
 * only a session's cwd.
 */
export async function gitStatus(cwd: string | null): Promise<GitStatus> {
  const none: GitStatus = { available: false, branch: null, dirty: 0 };
  if (!cwd || !fs.existsSync(cwd)) return none;
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch == null) return none; // not a git work tree (or git missing)
  const porcelain = await git(cwd, ["status", "--porcelain"]);
  const dirty = porcelain ? porcelain.split("\n").filter((l) => l.length).length : 0;
  return { available: true, branch, dirty };
}

/** Assemble the per-session widget payload for one session. */
export async function readWidgets(sessionId: string): Promise<WidgetData> {
  const init = latestInit(sessionId);
  const row = getDb()
    .prepare("SELECT cwd FROM session WHERE id = ?")
    .get(sessionId) as { cwd?: string } | undefined;
  return {
    mcp: parseMcp(init),
    git: await gitStatus(row?.cwd ?? null),
    context: readContextUsage(sessionId, row?.cwd ?? null),
  };
}
