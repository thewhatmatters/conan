import { execFile } from "node:child_process";
import { getDb } from "../db/index.js";

/**
 * Detect whether the local user has Claude Code installed and reachable from
 * the exact shell environment Conan's terminal pty would launch into. The
 * answer drives:
 *   - the first-launch banner ("Install Claude Code…") at the top of the
 *     terminal pane,
 *   - the Settings ▸ Status diagnostic line,
 *   - the empty-state copy in the Usage / Skills / Pulse tabs (so they don't
 *     advise "Awaiting a live Claude session" to a user who can't start one).
 *
 * The check has one non-obvious wrinkle that justifies a whole module: macOS
 * apps launched from Finder/Spotlight get a stripped login env that does NOT
 * source `~/.zshrc`. Most users add `~/.local/bin` (the official Claude Code
 * installer) or `~/.npm-global/bin` to PATH in `.zshrc`, so a naive
 * `execSync("claude --version")` reports "not installed" even when it is. We
 * mirror the pty's `resolveCommand()` (terminal/index.ts) by running through
 * an interactive login shell (`zsh -i -l`) so the probe sees the same PATH
 * the user's actual terminal would. Cached in-memory; refresh via
 * `clearClaudeDetection()` after a known install/uninstall (currently unused).
 */

export interface ClaudeDetection {
  /** True iff `command -v claude` printed a path AND `claude --version` ran. */
  installed: boolean;
  /** Semver string parsed from `claude --version` output (e.g. "2.1.155"), or null. */
  version: string | null;
  /** Absolute path the shell resolved for `claude` (whatever `command -v` returned). */
  path: string | null;
  /** Error message when the probe itself failed (timeout, shell missing), else null. */
  error: string | null;
  /** Epoch ms the result was cached. */
  checkedAt: number;
}

let cached: ClaudeDetection | null = null;
let inFlight: Promise<ClaudeDetection> | null = null;

const SHELL = process.env.SHELL ?? "/bin/zsh";
/** Bound: a slow shell startup shouldn't block the gateway forever. */
const PROBE_TIMEOUT_MS = 5_000;
/** Re-probe at most every 10 minutes — installs are rare; cache is cheap. */
const CACHE_TTL_MS = 10 * 60_000;

/** Run a one-shot command in the same interactive login shell the pty uses.
 *  Resolves with stdout (trimmed) on success; rejects on non-zero exit, signal,
 *  or timeout. Stderr is discarded — we only care about the shell-resolved
 *  answer, not why it failed. */
function probe(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      SHELL,
      ["-i", "-l", "-c", cmd],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Detect Claude Code. Memoized — the first call probes, subsequent calls
 * within `CACHE_TTL_MS` return the cached answer. Concurrent calls de-dupe
 * onto the same in-flight probe.
 *
 * Never throws. Probe failures (shell missing, timeout) come back as a
 * structured `{installed: false, error: <message>}` so callers can show a
 * meaningful diagnostic instead of guessing why the surface is empty.
 *
 * Fallback signal: if the live probe says "not installed" but the gateway
 * database has a `session.claude_version` row from a past SessionStart hook
 * (US-001 v4.4), we surface THAT version as the answer with `installed: true`.
 * Rationale: SessionStart writes prove Claude ran successfully on this machine
 * at least once — if the probe misses it now, the user's PATH config is the
 * problem, not Claude itself. We still flag the version honestly.
 */
export async function detectClaude(): Promise<ClaudeDetection> {
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const result = await runProbe();
    cached = result;
    inFlight = null;
    return result;
  })();
  return inFlight;
}

async function runProbe(): Promise<ClaudeDetection> {
  let path: string | null = null;
  try {
    const out = await probe("command -v claude");
    if (out) path = out.split("\n")[0]!.trim();
  } catch (err) {
    // Probe shell itself failed — try the historical signal before giving up.
    const fromDb = historicalVersion();
    if (fromDb) {
      return {
        installed: true,
        version: fromDb,
        path: null,
        error: `live probe failed (${(err as Error).message}); using last observed`,
        checkedAt: Date.now(),
      };
    }
    return {
      installed: false,
      version: null,
      path: null,
      error: (err as Error).message,
      checkedAt: Date.now(),
    };
  }

  if (!path) {
    // No live `claude` on PATH. Try the historical signal — maybe the user
    // installed it once, ran it, then changed PATH; the binary may still
    // exist but `command -v` can't find it from this shell env.
    const fromDb = historicalVersion();
    if (fromDb) {
      return {
        installed: true,
        version: fromDb,
        path: null,
        error: "not on PATH from this shell — using last observed version",
        checkedAt: Date.now(),
      };
    }
    return {
      installed: false,
      version: null,
      path: null,
      error: null,
      checkedAt: Date.now(),
    };
  }

  // We have a path — try to read the version. A successful path resolution
  // with a failing --version is still "installed" (a partial Claude is more
  // than no Claude), so we don't fail closed here.
  let version: string | null = null;
  try {
    const out = await probe(`"${path}" --version`);
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    if (m) version = m[1] ?? null;
  } catch {
    // Version probe failed but path resolved — still consider it installed.
  }

  return {
    installed: true,
    version,
    path,
    error: null,
    checkedAt: Date.now(),
  };
}

/** Most recent `claude_version` seen on a session row, captured by the
 *  SessionStart hook (v4.4 US-001). Null when no session has ever connected.
 *  Used as a fallback signal when the live shell probe misses the install. */
function historicalVersion(): string | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT claude_version FROM session
          WHERE claude_version IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get() as { claude_version?: string } | undefined;
    if (!row?.claude_version) return null;
    const m = /(\d+\.\d+\.\d+)/.exec(row.claude_version);
    return m?.[1] ?? row.claude_version;
  } catch {
    return null;
  }
}

/** Drop the cached detection — forces a re-probe on the next `detectClaude()`. */
export function clearClaudeDetection(): void {
  cached = null;
  inFlight = null;
}
