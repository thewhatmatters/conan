// MCP server listing (v4.4 fix) — the source of truth for the HUD's MCP tab.
//
// Conan observes Claude Code over HOOKS, and the SessionStart hook payload does
// NOT carry `mcp_servers` (only session_id/transcript_path/cwd/hook_event_name/
// source/model). The `system/init` message that DOES carry mcp_servers only
// exists in the headless `claude -p --output-format stream-json` path, which we
// don't use. So the original per-session `WidgetData.mcp` was always null.
//
// Instead we shell out to `claude mcp list` — the same global health-checked
// view as the TUI `/mcp` screen — and parse its human output (there is no
// `--json`). This is account/install-global, not per-session, which matches
// what `/mcp` shows.

import { execFile } from "node:child_process";

/** A configured MCP server + its live health, as `claude mcp list` reports it. */
export interface McpServer {
  name: string;
  /** Endpoint/url (or command for stdio servers). */
  url: string | null;
  /** Transport tag when present, e.g. "HTTP", "SSE". */
  transport: string | null;
  /** Normalized status: connected | failed | needs-authentication | <other>. */
  status: string;
  /** The raw status text as printed, e.g. "Failed to connect". */
  statusText: string;
}

/** The `claude` binary to invoke; override with CONAN_CLAUDE_BIN (matches the terminal/probe). */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/**
 * Parse one `claude mcp list` line into a server, or null if it's not a server
 * row (header / blank / summary). Format observed:
 *   "<name>: <url>[ (<TRANSPORT>)] - <symbol> <status text>"
 * e.g.
 *   "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✓ Connected"
 *   "paper: http://127.0.0.1:29979/mcp (HTTP) - ✗ Failed to connect"
 *   "claude.ai Google Drive: …/mcp/v1 - ! Needs authentication"
 * The name may contain spaces; the URL contains "://" (colon without a trailing
 * space) so splitting on the first ": " safely separates name from the rest.
 */
export function parseMcpListLine(line: string): McpServer | null {
  const m = /^(.+?): (.+?) - (.+)$/.exec(line.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  let target = m[2]!.trim();
  const statusRaw = m[3]!.trim();

  // Pull a trailing "(TRANSPORT)" off the target if present.
  let transport: string | null = null;
  const t = /\(([^)]+)\)\s*$/.exec(target);
  if (t) {
    transport = t[1]!.trim();
    target = target.slice(0, t.index).trim();
  }

  // Strip a leading status symbol (✓ / ✗ / ! / •) and surrounding whitespace.
  const statusText = statusRaw.replace(/^[^A-Za-z0-9]+/, "").trim();
  const status = normalizeStatus(statusText);

  return { name, url: target || null, transport, status, statusText };
}

/** Normalize `claude mcp list`'s status phrase into a stable token. */
function normalizeStatus(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("connected")) return "connected";
  if (t.includes("fail")) return "failed";
  if (t.includes("needs authentication") || t.includes("authenticat"))
    return "needs-authentication";
  if (t.includes("pending") || t.includes("connecting")) return "pending";
  return t.replace(/\s+/g, "-") || "unknown";
}

/** Parse the full `claude mcp list` stdout into the server list. */
export function parseMcpList(stdout: string): McpServer[] {
  return stdout
    .split("\n")
    .map(parseMcpListLine)
    .filter((s): s is McpServer => s !== null);
}

/**
 * Run `claude mcp list` (a real health check — it dials each server, so it can
 * take a few seconds) and return the parsed servers. Resolves to `[]` with an
 * `error` when the binary is missing or the call fails/timeouts; never throws.
 * Runs through a login shell so the user's PATH resolves `claude` the same way
 * the terminal does.
 */
export function listMcpServers(
  timeoutMs = 15_000,
): Promise<{ servers: McpServer[]; error: string | null }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    execFile(
      shell,
      ["-l", "-c", `${CLAUDE_BIN} mcp list`],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const servers = parseMcpList(stdout || "");
        // `claude mcp list` exits non-zero when a server fails its health check,
        // yet still prints the rows — so trust parsed rows over the exit code.
        if (servers.length === 0 && err) {
          resolve({ servers: [], error: err.message });
        } else {
          resolve({ servers, error: null });
        }
      },
    );
  });
}

// Tiny TTL cache so flipping to the MCP tab (or re-renders) doesn't re-dial all
// servers every time; a manual refresh on the UI bypasses it via `force`.
let cache: { at: number; servers: McpServer[]; error: string | null } | null = null;
const TTL_MS = 30_000;

/** Cached server list; spawns a fresh `claude mcp list` only past the TTL or when forced. */
export async function getMcpServers(
  force = false,
): Promise<{ servers: McpServer[]; error: string | null; at: number }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { ...cache };
  }
  const { servers, error } = await listMcpServers();
  cache = { at: Date.now(), servers, error };
  return { ...cache };
}
