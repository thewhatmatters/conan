// US-003: data source for the MCP servers widget (US-011). Claude Code keeps no
// live "connected" MCP registry on disk, so we infer status from the files it
// does write, then enrich with the only true per-run signal — a live session's
// captured system/init mcp_servers array.
//
// Three disk inputs (all optional; any missing file degrades gracefully):
//   - ~/.claude/settings.json        mcpServers → the user-configured servers
//   - <cwd>/.mcp.json                mcpServers → project-scoped servers
//   - ~/.claude/mcp-needs-auth-cache.json  keys → servers needing (re)auth
//
// Inference: a configured server is assumed "connected" unless it appears in
// the needs-auth cache, in which case it is "needs-auth". When a live session's
// system/init mcp_servers array is supplied, it overrides the inferred status
// per server (it's the real connected/failed/auth signal for that run).
//
// Pure file reads (+ an injected session array); the gateway route is a thin
// wrapper. readMcpStatus() takes explicit paths so tests can point at fixtures.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { getDb } from "../db/index.js";
import type { McpServer } from "../widgets/index.js";

const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
const NEEDS_AUTH_PATH = path.join(HOME, ".claude", "mcp-needs-auth-cache.json");

/** A configured/observed MCP server as the UI consumes it. */
export interface McpServerStatus {
  name: string;
  status: "connected" | "needs-auth" | "failed";
  /** Where the status came from: inferred from config, or a live session. */
  source: "config" | "session";
}

/** Normalized MCP status returned by GET /api/claude/mcp. */
export interface McpStatusPayload {
  /** Every known server, name-sorted, with its resolved status + source. */
  servers: McpServerStatus[];
  /** Servers currently treated as connected (configured/observed minus auth). */
  connectedCount: number;
  /** Distinct servers configured on disk (settings + project .mcp.json). */
  configuredCount: number;
  /** Servers flagged as needing (re)auth. */
  needsAuthCount: number;
  /** true when a live session's system/init mcp_servers overrode the inference. */
  fromLiveSession: boolean;
  /** false when nothing is configured and no live session reported any server. */
  hasData: boolean;
}

/** Read a JSON file, returning a parsed object or null on any failure. */
function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract the keys of a top-level `mcpServers` map, if present. */
function configuredNames(filePath: string): string[] {
  const obj = readJson(filePath);
  const m = obj?.mcpServers;
  return m && typeof m === "object" ? Object.keys(m as object) : [];
}

/**
 * Map a raw status string from a session's system/init mcp_servers entry onto
 * our three-state model. Claude reports things like "connected", "failed",
 * "needs-authentication"/"pending" — anything auth-ish becomes needs-auth, any
 * non-connected/non-auth state is treated as failed.
 */
function normalizeSessionStatus(raw: string): McpServerStatus["status"] {
  const s = raw.toLowerCase();
  if (s === "connected") return "connected";
  if (s.includes("auth")) return "needs-auth";
  return "failed";
}

export interface ReadMcpOptions {
  /** Override the ~/.claude/settings.json path (tests). */
  settingsPath?: string;
  /** Override the ~/.claude/mcp-needs-auth-cache.json path (tests). */
  needsAuthPath?: string;
  /** Project .mcp.json path to also read (default: <cwd>/.mcp.json). */
  projectMcpPath?: string | null;
  /** Live per-run mcp_servers from a session's system/init; overrides config. */
  sessionMcp?: McpServer[] | null;
}

/**
 * Assemble MCP status from disk config + an optional live-session override.
 * Pure (apart from the file reads); exported and fixture-driven for testing.
 */
export function readMcpStatus(opts: ReadMcpOptions = {}): McpStatusPayload {
  const settingsPath = opts.settingsPath ?? SETTINGS_PATH;
  const needsAuthPath = opts.needsAuthPath ?? NEEDS_AUTH_PATH;
  const projectMcpPath =
    opts.projectMcpPath === undefined
      ? path.join(process.cwd(), ".mcp.json")
      : opts.projectMcpPath;

  // 1) Configured servers: settings.json + project .mcp.json (de-duped).
  const configured = new Set<string>(configuredNames(settingsPath));
  if (projectMcpPath) {
    for (const n of configuredNames(projectMcpPath)) configured.add(n);
  }

  // 2) Negative signal: servers the cache says need (re)auth, keyed by name.
  const needsAuth = new Set<string>(Object.keys(readJson(needsAuthPath) ?? {}));

  // 3) Infer a status for every configured server.
  const byName = new Map<string, McpServerStatus>();
  for (const name of configured) {
    byName.set(name, {
      name,
      status: needsAuth.has(name) ? "needs-auth" : "connected",
      source: "config",
    });
  }

  // 4) Enrich/override with the live session's real per-run statuses.
  const sessionMcp = opts.sessionMcp ?? null;
  const fromLiveSession = Array.isArray(sessionMcp) && sessionMcp.length > 0;
  if (fromLiveSession) {
    for (const s of sessionMcp!) {
      byName.set(s.name, {
        name: s.name,
        status: normalizeSessionStatus(s.status),
        source: "session",
      });
    }
  }

  const servers = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return {
    servers,
    connectedCount: servers.filter((s) => s.status === "connected").length,
    configuredCount: configured.size,
    needsAuthCount: servers.filter((s) => s.status === "needs-auth").length,
    fromLiveSession,
    hasData: servers.length > 0,
  };
}

/**
 * The most-recent live (running/idle) session's system/init mcp_servers array,
 * or null when no active session has reported one. This is the only true
 * connected/failed signal; readMcpStatus() folds it over the disk inference.
 */
export function liveSessionMcp(): McpServer[] | null {
  const row = getDb()
    .prepare(
      `SELECT e.payload AS payload
         FROM event e
         JOIN session s ON s.id = e.session_id
        WHERE e.stream_type = 'system/init'
          AND s.status IN ('running', 'idle')
        ORDER BY e.ts DESC
        LIMIT 1`,
    )
    .get() as { payload: string } | undefined;
  if (!row) return null;
  let init: Record<string, unknown>;
  try {
    init = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = init.mcp_servers;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      name: typeof o.name === "string" ? o.name : "unknown",
      status: typeof o.status === "string" ? o.status : "unknown",
    };
  });
}
