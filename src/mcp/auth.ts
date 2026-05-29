// US-011: MCP OAuth auth driver. `claude mcp` has NO auth subcommand (confirmed
// in the US-010 spike, docs/mcp-auth-spike.md) — (re)authenticating a remote MCP
// server is only reachable through the interactive `/mcp` TUI. So to offer
// one-click Authenticate / Reconnect from Conan's HUD we spawn a *throwaway*
// `claude` pty (the same spawn-drive-capture-kill lifecycle as the /usage probe
// in src/usage/probe.ts), open `/mcp`, navigate to the target server, fire its
// action, and kill the pty.
//
// The navigation is NAME-keyed (read the highlighted `❯ <name>` per ↓) and the
// action is LABEL-keyed (read `N. <label>` on the detail screen) — never indexed
// off `claude mcp list`, whose ordering + membership diverge from `/mcp` (see the
// spike doc). The pure navigation/parse helpers below are exported and unit-tested
// against the captured spike fixtures (scripts/fixtures/mcp-tui/); the live driver
// needs a real logged-in claude so it can't run in CI (like probeUsage).
//
// Consent happens out-of-band in the browser — the TUI just opens it and waits
// ("Press Enter after authenticating…"). The driver's job is done the moment it
// fires Authenticate and the browser opens; completion is detected later by
// polling `claude mcp list` (US-012), NOT by reading this pty.

import * as pty from "node-pty";
import { stripAnsi } from "../usage/probe.js";

/** A throwaway-pty MCP auth attempt result. Never thrown — always returned. */
export interface McpAuthResult {
  /** The server name we were asked to drive. */
  server: string;
  /** True once the requested action was fired into the TUI. */
  ok: boolean;
  /** Which action actually fired ("authenticate"|"reconnect"), or null if none. */
  action: McpAuthAction | null;
  /** The server name we navigated onto (for diagnostics), or null. */
  landedOn: string | null;
  /** True when the post-action pending/browser-handoff frame was observed. */
  pending: boolean;
  /** Human error reason when ok=false, else null. */
  error: string | null;
}

/** The action a caller can request the driver fire on a server's detail screen. */
export type McpAuthAction = "authenticate" | "reconnect";

/** One numbered action on a server's `/mcp` detail screen, e.g. {index:1,label:"Authenticate"}. */
export interface McpDetailAction {
  index: number;
  label: string;
}

/** The `claude` binary to drive; override with CONAN_CLAUDE_BIN (matches the probe/terminal). */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

// --- pure navigation/parse helpers (unit-tested against spike fixtures) ------

/**
 * Pull the highlighted server name out of a `/mcp` list redraw delta. A ↓ keypress
 * re-renders both the row we left and the row we landed on, e.g.
 *   "refero ·  connected · 8 tools❯ paper ·  failed"
 * The name we want is the one after the LAST `❯`, up to its " · <status>" tail.
 * Returns null when the delta carries no highlighted row (timing/no-op redraws).
 */
export function parseHighlightedServer(delta: string): string | null {
  const text = stripAnsi(delta);
  const lastCursor = text.lastIndexOf("❯");
  if (lastCursor < 0) return null;
  const tail = text.slice(lastCursor + 1);
  // Name runs until the first " · <status>" separator. The cursor row in the
  // list always has a "· <status>" tail; bail if it doesn't (e.g. the prompt).
  const m = /^\s*([^·]+?)\s*·/.exec(tail);
  if (!m) return null;
  const name = (m[1] ?? "").trim();
  return name || null;
}

/** Normalize a server name for matching: lowercased, all whitespace + glue glyphs removed. */
function normalizeServerName(name: string): string {
  return name.toLowerCase().replace(/[\s·…]+/g, "");
}

/**
 * Whitespace-tolerant server-name equality. The TUI glues column-positioned names
 * ("claude.aiGoogleDrive") while `claude mcp list` and the redraw deltas keep
 * spaces ("claude.ai Google Drive") — normalizing both away makes them comparable.
 */
export function serversMatch(a: string, b: string): boolean {
  return normalizeServerName(a) === normalizeServerName(b);
}

/** Parse "N servers" off a `/mcp` frame (used only to bound the navigation walk). */
export function parseServerCount(frame: string): number | null {
  const m = /(\d+)\s*servers?/i.exec(stripAnsi(frame));
  return m ? Number(m[1]) : null;
}

/**
 * Parse the numbered action menu of a server's detail screen into {index,label}
 * rows, e.g. "❯1. Authenticate2. Disable↑/↓ to navigate…" → [{1,"Authenticate"},
 * {2,"Disable"}]. Column positioning glues the labels together, so each `N.` is
 * matched with the label running until the next `N.` or the navigation footer.
 * Requiring a LETTER right after `N.` keeps embedded numbers (IPs/URLs like
 * "127.0.0.1", "/mcp/v1") from being misread as actions. Returns [] when absent.
 */
export function parseDetailActions(frame: string): McpDetailAction[] {
  // Collapse all whitespace (the TUI emits bare \r between rows) so a trailing
  // \r can't defeat the end-of-label lookahead, then cut the navigation footer.
  const text = stripAnsi(frame).replace(/\s+/g, " ");
  const body = (text.split(/↑\/↓|Esc\s*to\s*back/)[0] ?? "").trim();
  const re = /(\d+)\.\s*([A-Za-z][A-Za-z\- ]*?)(?=\s*\d+\.|$)/g;
  const out: McpDetailAction[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const label = (m[2] ?? "").trim();
    if (label) out.push({ index: Number(m[1]), label });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * 0-based offset (in selectable order, cursor starting at the first action) of the
 * action whose label matches `target`. Prefers an exact label match, then a
 * startsWith — so "Authenticate" never matches "Re-authenticate". Returns null
 * when the action is absent (e.g. a connected server has no plain "Authenticate").
 */
export function findActionOffset(
  actions: McpDetailAction[],
  target: string,
): number | null {
  const t = target.toLowerCase();
  const exact = actions.findIndex((a) => a.label.toLowerCase() === t);
  if (exact >= 0) return exact;
  const starts = actions.findIndex((a) => a.label.toLowerCase().startsWith(t));
  return starts >= 0 ? starts : null;
}

/** True once the `/mcp` server list has rendered (the navigate footer is the sentinel). */
export function isListReady(buf: string): boolean {
  const compact = stripAnsi(buf).replace(/\s+/g, "");
  return /ManageMCPservers/i.test(compact) && /navigate/i.test(compact);
}

/** True once a server's detail action screen has rendered. */
export function isDetailReady(delta: string): boolean {
  const compact = stripAnsi(delta).replace(/\s+/g, "");
  return /Esctoback/i.test(compact) || /Entertoselect/i.test(compact);
}

/** True once the post-Authenticate pending/browser-handoff frame has rendered. */
export function isPendingFrame(delta: string): boolean {
  const compact = stripAnsi(delta).replace(/\s+/g, "");
  return /Authenticatingwith|browserwindowwillopen|start-auth|PressEnterafterauthenticating/i.test(
    compact,
  );
}

// --- live throwaway-pty driver (live-only; never throws; always cleans up) ---

const KEY = { down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b" } as const;

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const BOOT_MS = clampEnvInt("CONAN_MCP_AUTH_BOOT_MS", 6_000, 1_000, 30_000);
const STEP_MS = clampEnvInt("CONAN_MCP_AUTH_STEP_MS", 1_100, 200, 5_000);
const STEP_SHORT_MS = Math.max(300, Math.floor(STEP_MS / 2));
const READY_TIMEOUT_MS = clampEnvInt("CONAN_MCP_AUTH_READY_MS", 9_000, 2_000, 30_000);
const PENDING_TIMEOUT_MS = clampEnvInt("CONAN_MCP_AUTH_PENDING_MS", 6_000, 1_000, 30_000);
const DRIVE_TIMEOUT_MS = clampEnvInt("CONAN_MCP_AUTH_TIMEOUT_MS", 75_000, 10_000, 240_000);
const POLL_MS = 200;

/** Clean string env for the driver pty (drops undefined values; forces a real TERM). */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Drive `/mcp` in a throwaway `claude` pty to fire an auth action on `serverName`.
 * Spawns a dedicated pty (NOT the user's correlated session — the global MCP list
 * and the terminal are untouched), opens `/mcp`, name-navigates to the server,
 * label-selects the action, fires it, then ALWAYS kills the pty (success, error,
 * or timeout — no stray ptys). Never throws; failures resolve with ok=false + a
 * reason. `action` defaults to "authenticate"; "reconnect" falls back to
 * Authenticate when the server exposes no Reconnect (auth-shaped failure).
 * Disabled by CONAN_DISABLE_MCP_AUTH=1 (tests/CI — no real claude is launched).
 */
export async function driveMcpAuth(
  serverName: string,
  opts: { action?: McpAuthAction } = {},
): Promise<McpAuthResult> {
  const action: McpAuthAction = opts.action ?? "authenticate";
  const result: McpAuthResult = {
    server: serverName,
    ok: false,
    action: null,
    landedOn: null,
    pending: false,
    error: null,
  };

  if (process.env.CONAN_DISABLE_MCP_AUTH === "1") {
    result.error = "mcp auth disabled (CONAN_DISABLE_MCP_AUTH=1)";
    return result;
  }

  const shell = process.env.SHELL ?? "/bin/zsh";
  let term: pty.IPty;
  let buf = "";
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  };

  try {
    term = pty.spawn(shell, ["-l", "-c", CLAUDE_BIN], {
      name: "xterm-256color",
      cols: 120,
      rows: 45,
      cwd: process.env.HOME ?? process.cwd(),
      env: ptyEnv(),
    });
  } catch (e) {
    result.error = `failed to spawn pty: ${errMsg(e)}`;
    return result;
  }

  term.onData((d) => {
    buf += d;
  });

  const deadline = Date.now() + DRIVE_TIMEOUT_MS;
  const timeLeft = () => deadline - Date.now();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Poll the buffer until `pred` holds or `timeout`/the overall deadline elapses.
  const waitFor = async (pred: (b: string) => boolean, timeout: number): Promise<boolean> => {
    const end = Math.min(Date.now() + timeout, deadline);
    while (Date.now() < end && !killed) {
      if (pred(buf)) return true;
      await sleep(POLL_MS);
    }
    return pred(buf);
  };

  try {
    await sleep(BOOT_MS);
    if (timeLeft() <= 0) throw new Error("timed out before /mcp could open");

    term.write("/mcp\r");
    if (!(await waitFor(isListReady, READY_TIMEOUT_MS))) {
      throw new Error("/mcp server list did not render");
    }

    // Name-keyed walk: ↓ until the highlighted row matches the target. Bounded by
    // the server count (down wraps, so the target is always reached or we wrap).
    const maxSteps = (parseServerCount(buf) ?? 30) + 2;
    let landed: string | null = null;
    for (let i = 0; i < maxSteps; i++) {
      if (timeLeft() <= 0) throw new Error("timed out navigating the server list");
      const before = buf.length;
      term.write(KEY.down);
      await sleep(STEP_MS);
      const name = parseHighlightedServer(buf.slice(before));
      if (name) {
        landed = name;
        result.landedOn = name;
        if (serversMatch(name, serverName)) break;
      }
    }
    if (!landed || !serversMatch(landed, serverName)) {
      throw new Error(`server "${serverName}" not found in /mcp (landed on ${landed ?? "?"})`);
    }

    // Open the detail screen and parse its action menu.
    const beforeEnter = buf.length;
    term.write(KEY.enter);
    const detailOk = await waitFor((b) => isDetailReady(b.slice(beforeEnter)), READY_TIMEOUT_MS);
    const actions = parseDetailActions(buf.slice(beforeEnter));
    if (!detailOk || actions.length === 0) {
      throw new Error(`detail screen for "${serverName}" rendered no actions`);
    }

    // Label-keyed action select. Reconnect escalates to Authenticate when the
    // server exposes no Reconnect (an auth-shaped failure / needs-authentication).
    const wanted = action === "reconnect" ? "Reconnect" : "Authenticate";
    let firedAction: McpAuthAction = action;
    let offset = findActionOffset(actions, wanted);
    if (offset == null && action === "reconnect") {
      offset = findActionOffset(actions, "Authenticate");
      firedAction = "authenticate";
    }
    if (offset == null) {
      throw new Error(
        `no "${wanted}" action for "${serverName}" (actions: ${actions.map((a) => a.label).join(", ")})`,
      );
    }

    for (let i = 0; i < offset; i++) {
      if (timeLeft() <= 0) throw new Error("timed out selecting the action");
      term.write(KEY.down);
      await sleep(STEP_SHORT_MS);
    }
    const beforeFire = buf.length;
    term.write(KEY.enter);

    // Authenticate opens the browser + renders a pending frame; Reconnect just
    // re-checks health (may render nothing). Firing the action IS success — the
    // pending frame is reported when seen but not required.
    result.pending = await waitFor((b) => isPendingFrame(b.slice(beforeFire)), PENDING_TIMEOUT_MS);
    result.action = firedAction;
    result.ok = true;
  } catch (e) {
    result.error = errMsg(e);
  } finally {
    kill();
  }
  return result;
}
