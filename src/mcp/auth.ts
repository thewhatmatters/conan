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
import { getMcpServers, type McpServer } from "./index.js";

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

// --- US-012: completion polling ----------------------------------------------
//
// driveMcpAuth (US-011) only FIRES Authenticate — the OAuth consent then happens
// out-of-band in the user's browser, so the throwaway pty can't observe the
// finish. Instead we poll `claude mcp list` (getMcpServers(true), bypassing its
// TTL cache so each poll re-dials) until the target server flips to `connected`
// or a bounded timeout elapses. The poll is cancellable via an AbortSignal and
// clears its sleep timer on abort/finish so an abandoned attempt leaks nothing.

/** The lifecycle status of an in-flight MCP auth attempt. */
export type McpAuthStatus = "pending" | "connected" | "timeout";

/** Terminal result of polling for an MCP auth to complete. */
export interface McpAuthPollResult {
  /** The server we were polling for. */
  server: string;
  /** `connected` once it flips healthy, else `timeout` (incl. abort). */
  status: McpAuthStatus;
  /** The last-seen normalized status of the server (for diagnostics), or null. */
  lastStatus: string | null;
  /** How many list polls were issued. */
  polls: number;
}

/** The injectable lister shape — defaults to getMcpServers; fakeable in tests. */
type McpLister = (
  force: boolean,
) => Promise<{ servers: McpServer[]; error: string | null; at: number }>;

const POLL_INTERVAL_MS = clampEnvInt("CONAN_MCP_POLL_INTERVAL_MS", 2_500, 250, 30_000);
const POLL_TIMEOUT_MS = clampEnvInt("CONAN_MCP_POLL_TIMEOUT_MS", 120_000, 1_000, 600_000);

/** A timer-clean sleep that resolves early (and clears its timer) on abort. */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll `claude mcp list` (forced, cache-bypassing) until `serverName` reports
 * `connected` or the timeout elapses. Resolves with `connected` on the flip, or
 * `timeout` when the deadline passes / the attempt is aborted — never throws (a
 * failed list call is swallowed and retried). Bounded by `timeoutMs`; honors an
 * AbortSignal and clears its sleep timer so an abandoned poll leaks no timers.
 * The `list` dep is injectable so the flip-to-connected / timeout branches are
 * unit-testable without a real `claude`.
 */
export async function pollMcpAuthCompletion(
  serverName: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    list?: McpLister;
  } = {},
): Promise<McpAuthPollResult> {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const list = opts.list ?? getMcpServers;
  const signal = opts.signal;
  const deadline = Date.now() + timeoutMs;

  let polls = 0;
  let lastStatus: string | null = null;

  while (Date.now() < deadline && !signal?.aborted) {
    polls++;
    try {
      const { servers } = await list(true);
      const match = servers.find((s) => serversMatch(s.name, serverName));
      if (match) {
        lastStatus = match.status;
        if (match.status === "connected") {
          return { server: serverName, status: "connected", lastStatus, polls };
        }
      }
    } catch {
      /* a failed list poll is non-fatal — retry until the deadline */
    }

    if (signal?.aborted) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await cancellableSleep(Math.min(intervalMs, remaining), signal);
  }

  return { server: serverName, status: "timeout", lastStatus, polls };
}

// --- US-013: in-flight auth registry + route entry points --------------------
//
// The gateway routes (POST /api/claude/mcp/:name/authenticate|reconnect) drive
// the throwaway-pty auth (US-011) then poll for completion (US-012) as ONE
// fire-and-forget flight per server. We keep a tiny registry, keyed by the
// normalized server name, so a second authenticate while one is already pending
// is debounced (the OAuth consent is happening in the browser — re-driving the
// TUI would race a second pty against the same server). A flight stays in the
// registry after it finishes (connected/timeout) so the UI can read the last
// outcome; only a `pending` flight blocks a new start.

/** Public snapshot of an in-flight (or just-finished) MCP auth flight. */
export interface McpAuthFlightState {
  /** The server name the flight is for. */
  server: string;
  /** pending while driving/polling; connected once it flips healthy; timeout otherwise. */
  status: McpAuthStatus;
  /** Which action actually fired ("authenticate"|"reconnect"), or null pre-fire. */
  action: McpAuthAction | null;
  /** When the flight started (epoch ms). */
  startedAt: number;
  /** Human error reason when the drive failed, else null. */
  error: string | null;
}

interface Flight extends McpAuthFlightState {
  /** Cancels the completion poll if the flight is abandoned. */
  controller: AbortController;
}

const flights = new Map<string, Flight>();

const snapshot = (f: Flight): McpAuthFlightState => ({
  server: f.server,
  status: f.status,
  action: f.action,
  startedAt: f.startedAt,
  error: f.error,
});

/** True when an auth flight for this server is currently pending. */
export function isMcpAuthInFlight(serverName: string): boolean {
  const f = flights.get(normalizeServerName(serverName));
  return f != null && f.status === "pending";
}

/** Last-known auth flight snapshot for a server (in-flight or finished), or null. */
export function getMcpAuthState(serverName: string): McpAuthFlightState | null {
  const f = flights.get(normalizeServerName(serverName));
  return f ? snapshot(f) : null;
}

/** Result of attempting to start an auth flight. */
export interface McpAuthStartResult {
  /** True when a fresh flight was started; false when debounced. */
  started: boolean;
  /** True when rejected because a flight for this server was already pending. */
  alreadyInFlight: boolean;
  /** The current flight snapshot (the live one when debounced, the new one when started). */
  state: McpAuthFlightState;
}

/** Injectable hooks for unit-testing the registry without a real claude pty. */
interface AuthFlightDeps {
  drive?: typeof driveMcpAuth;
  poll?: typeof pollMcpAuthCompletion;
}

/**
 * Start a fire-and-forget auth flight for `serverName`: drive the `/mcp` TUI
 * (US-011) then poll `claude mcp list` for the flip to `connected` (US-012),
 * mutating the registry's flight in place (pending → connected|timeout). If a
 * flight is already pending for this server, NO new flight starts — the live
 * snapshot is returned with `alreadyInFlight:true` (debounce). Never throws; the
 * underlying helpers swallow their own errors. `action` defaults to "authenticate".
 */
export function startMcpAuth(
  serverName: string,
  opts: { action?: McpAuthAction } & AuthFlightDeps = {},
): McpAuthStartResult {
  const action: McpAuthAction = opts.action ?? "authenticate";
  const key = normalizeServerName(serverName);

  const existing = flights.get(key);
  if (existing && existing.status === "pending") {
    return { started: false, alreadyInFlight: true, state: snapshot(existing) };
  }

  const controller = new AbortController();
  const flight: Flight = {
    server: serverName,
    status: "pending",
    action: null,
    startedAt: Date.now(),
    error: null,
    controller,
  };
  flights.set(key, flight);

  const drive = opts.drive ?? driveMcpAuth;
  const poll = opts.poll ?? pollMcpAuthCompletion;

  void (async () => {
    const driveResult = await drive(serverName, { action });
    flight.action = driveResult.action ?? action;
    if (!driveResult.ok) {
      flight.status = "timeout";
      flight.error = driveResult.error;
      return;
    }
    const pollResult = await poll(serverName, { signal: controller.signal });
    flight.status = pollResult.status === "connected" ? "connected" : "timeout";
  })();

  return { started: true, alreadyInFlight: false, state: snapshot(flight) };
}

/** Result of a reconnect (forced re-health-check, with optional auth escalation). */
export interface McpReconnectResult {
  /** The server name we re-checked. */
  server: string;
  /** The normalized status after the forced re-dial, or null if the server is gone. */
  status: string | null;
  /** True when the re-dial reported an auth-shaped failure and we started an auth flight. */
  escalated: boolean;
  /** True when escalation hit an already-pending flight (debounced). */
  alreadyInFlight: boolean;
  /** The started auth flight snapshot when escalated, else null. */
  auth: McpAuthFlightState | null;
}

/**
 * Reconnect = a FORCED re-health-check (`getMcpServers(true)` re-dials every
 * server). We escalate to the authenticate flow ONLY when the target's refreshed
 * status is auth-shaped (`needs-authentication`); a plain `failed` server just
 * returns its refreshed status (reconnect can't fix a down server — that's the
 * UI's honest copy). Never throws. `list` is injectable for tests.
 */
export async function reconnectMcp(
  serverName: string,
  opts: { list?: McpLister } & AuthFlightDeps = {},
): Promise<McpReconnectResult> {
  const list = opts.list ?? getMcpServers;
  let status: string | null = null;
  try {
    const { servers } = await list(true);
    const match = servers.find((s) => serversMatch(s.name, serverName));
    status = match?.status ?? null;
  } catch {
    /* a failed re-dial leaves status null — reported as a non-escalated result */
  }

  if (status === "needs-authentication") {
    const started = startMcpAuth(serverName, {
      action: "authenticate",
      drive: opts.drive,
      poll: opts.poll,
    });
    return {
      server: serverName,
      status,
      escalated: true,
      alreadyInFlight: started.alreadyInFlight,
      auth: started.state,
    };
  }

  return { server: serverName, status, escalated: false, alreadyInFlight: false, auth: null };
}
