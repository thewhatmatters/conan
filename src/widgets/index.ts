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
import path from "node:path";
import { HOME } from "../paths.js";
import { getDb } from "../db/index.js";
import { readContextUsage, type ContextUsage } from "../transcript/index.js";
import { getCapturedContext, type ContextCapture } from "../context/index.js";
import { liveTerminalSessionIds } from "../terminal/index.js";

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
  /**
   * On-disk approximation of where the context window is going, by category
   * (US-007). Always present; categories with no contribution are omitted.
   */
  contextBreakdown: ContextBreakdown;
  /**
   * The EXACT /context breakdown captured from the session's live pty (US-009),
   * or null when none has been captured. When present the Context widget shows
   * it ("live · from /context") in place of the on-disk estimate.
   */
  liveContext: ContextCapture | null;
  /**
   * Whether this session has a live, correlated pty right now (US-009) — drives
   * whether the Context widget's on-demand Refresh control is enabled.
   */
  hasLivePty: boolean;
}

/** One category in the on-disk context approximation (US-007). */
export interface ContextCategory {
  key: "system" | "tools" | "mcp" | "memory" | "skills" | "messages";
  label: string;
  tokens: number;
}

/** The per-category context approximation Conan owns from disk (US-007). */
export interface ContextBreakdown {
  categories: ContextCategory[];
  /** Sum of the category approximations (matches the live total when known). */
  approxTotal: number;
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

/* ---- context breakdown (US-007) ----------------------------------------- */
//
// `/context` reports per-category usage (System prompt, System tools, MCP tools,
// Memory files, Skills, Messages) but the transcript `usage` block carries only
// totals — so Conan reconstructs the split from disk:
// memory = CLAUDE.md + MEMORY.md sizes, skills = SKILL.md sizes, MCP from
// ~/.claude.json, messages = the remainder of the real measured total. The base
// system prompt + built-in tool schemas can't be read from disk, so they're
// labeled constants in the right ballpark. This is an approximation Conan owns,
// NOT a /context scrape.

/** Rough bytes→tokens heuristic (≈4 chars/token for English+markdown). */
const CHARS_PER_TOKEN = 4;
/** Claude Code's base system prompt — roughly constant per session. */
const SYSTEM_PROMPT_TOKENS = 3_000;
/** Built-in tool schemas (Read/Write/Edit/Bash/…) — roughly constant. */
const SYSTEM_TOOLS_TOKENS = 12_000;
/** Approximate tokens one MCP server's tool definitions add to the window. */
const MCP_TOKENS_PER_SERVER = 1_000;

/** Encode a cwd the way Claude Code names its per-project folder (/ and . → -). */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Sum the byte sizes of the given files (missing files skipped) → token est. */
function fileTokens(...paths: string[]): number {
  let bytes = 0;
  for (const p of paths) {
    try {
      bytes += fs.statSync(p).size;
    } catch {
      /* missing → skip (degrade gracefully) */
    }
  }
  return Math.round(bytes / CHARS_PER_TOKEN);
}

/** Memory-file tokens: user + project CLAUDE.md and the project auto-memory index. */
function memoryTokens(cwd: string | null): number {
  const paths = [path.join(HOME, ".claude", "CLAUDE.md")];
  if (cwd) {
    paths.push(path.join(cwd, "CLAUDE.md"));
    paths.push(
      path.join(HOME, ".claude", "projects", encodeCwd(cwd), "memory", "MEMORY.md"),
    );
  }
  return fileTokens(...paths);
}

/** Skill tokens: sum of every SKILL.md under the user + project skills dirs. */
function skillTokens(cwd: string | null): number {
  const roots = [path.join(HOME, ".claude", "skills")];
  if (cwd) roots.push(path.join(cwd, ".claude", "skills"));
  let bytes = 0;
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // dir absent → skip
    }
    for (const name of entries) {
      try {
        bytes += fs.statSync(path.join(root, name, "SKILL.md")).size;
      } catch {
        /* not a skill dir */
      }
    }
  }
  return Math.round(bytes / CHARS_PER_TOKEN);
}

/** Configured MCP server count from ~/.claude.json (0 when absent/malformed). */
function mcpServerCount(): number {
  try {
    const o = JSON.parse(
      fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"),
    ) as Record<string, unknown>;
    const servers = o.mcpServers;
    if (servers && typeof servers === "object")
      return Object.keys(servers as Record<string, unknown>).length;
  } catch {
    /* missing/malformed → 0 */
  }
  return 0;
}

/**
 * Approximate the per-category context split for a session from disk (US-007).
 * `messages` absorbs the remainder of the real measured total (readContextUsage,
 * US-006) so the segments sum to the live total; when no total is known it's
 * approximated from the remaining disk sources only. Empty categories are omitted
 * so a missing source simply drops out rather than erroring.
 */
export function readContextBreakdown(
  sessionId: string,
  cwd: string | null,
): ContextBreakdown {
  const usage = readContextUsage(sessionId, cwd);
  const fixed: ContextCategory[] = [
    { key: "system", label: "System", tokens: SYSTEM_PROMPT_TOKENS },
    { key: "tools", label: "Tools", tokens: SYSTEM_TOOLS_TOKENS },
    { key: "mcp", label: "MCP", tokens: mcpServerCount() * MCP_TOKENS_PER_SERVER },
    { key: "memory", label: "Memory", tokens: memoryTokens(cwd) },
    { key: "skills", label: "Skills", tokens: skillTokens(cwd) },
  ];
  const fixedTotal = fixed.reduce((s, c) => s + c.tokens, 0);
  const messages =
    usage != null ? Math.max(0, usage.used - fixedTotal) : 0;
  const categories = [
    ...fixed,
    { key: "messages" as const, label: "Messages", tokens: messages },
  ].filter((c) => c.tokens > 0);
  const approxTotal = categories.reduce((s, c) => s + c.tokens, 0);
  return { categories, approxTotal };
}

/** Assemble the per-session widget payload for one session. */
export async function readWidgets(sessionId: string): Promise<WidgetData> {
  const init = latestInit(sessionId);
  const row = getDb()
    .prepare("SELECT cwd FROM session WHERE id = ?")
    .get(sessionId) as { cwd?: string } | undefined;
  const cwd = row?.cwd ?? null;
  return {
    mcp: parseMcp(init),
    git: await gitStatus(cwd),
    context: readContextUsage(sessionId, cwd),
    contextBreakdown: readContextBreakdown(sessionId, cwd),
    liveContext: getCapturedContext(sessionId),
    hasLivePty: liveTerminalSessionIds().has(sessionId),
  };
}
