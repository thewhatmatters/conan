// US-005: real plan-utilization via a controlled PTY scrape of Claude Code's
// `/usage` TUI screen. The live plan-usage % lives only in the claude process's
// `anthropic-ratelimit-unified-*` response headers — unreadable from the outside
// (confirmed: `--debug api` does NOT log them). The one confirmed real source is
// the rendered `/usage` frame, which prints the current 5-hour block and the
// 7-day window with a "% used" and a "Resets …" line.
//
// We spawn a short-lived, controlled `claude` pty, send `/usage`, capture the
// rendered frame, strip ANSI, and parse the two windows. The parser is pure and
// exported so it can be unit-tested against a captured sample frame (the live
// probe needs a real logged-in claude + a billed request, so it can't run in CI).
//
// The probe is bounded (overall timeout, killed the moment a parseable frame
// appears or the deadline hits) and leaves no stray ptys. The last good result
// is cached; callers probe lazily (on demand, throttled), never on a tight timer,
// and the usage route falls back to the US-004 token-trend baseline when there's
// no fresh scrape. Nothing here throws — failures resolve to null.

import * as pty from "node-pty";

/** One usage window (5-hour block or 7-day): % used + when it resets. */
export interface UsageWindow {
  /** Percent of the limit consumed (0–100+), as rendered by /usage. */
  utilizationPct: number;
  /** When the window resets (epoch ms), or null when unparseable. */
  resetAt: number | null;
}

/** Parsed plan utilization from a /usage frame (status derived from the windows). */
export interface PlanUtilization {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Overall posture derived from the windows: ok < 80% ≤ warning < 100% ≤ limit. */
  status: "ok" | "warning" | "limit";
  /** When this frame was captured (epoch ms). */
  probedAt: number;
}

/** The `claude` binary to probe; override with CONAN_CLAUDE_BIN (matches terminal). */
const CLAUDE_BIN = process.env.CONAN_CLAUDE_BIN ?? "claude";

/** Hard ceiling on a probe: boot + /usage render + parse. Killed at the deadline. */
const PROBE_TIMEOUT_MS = clampEnvInt("CONAN_USAGE_PROBE_TIMEOUT_MS", 30_000, 3_000, 120_000);

/** Don't re-probe more often than this — /usage makes a billed request. */
const PROBE_TTL_MS = clampEnvInt("CONAN_USAGE_PROBE_TTL_MS", 5 * 60_000, 10_000, 60 * 60_000);

/** Strip ANSI escape sequences (CSI, OSC, charset, etc.) from terminal output. */
export function stripAnsi(s: string): string {
  return s
    // OSC sequences: ESC ] … BEL  or  ESC ] … ESC \
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    // CSI sequences: ESC [ … <final byte>
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // 2-char escapes: charset select (ESC ( B), save/restore cursor (ESC 7/8), etc.
    .replace(/\x1b[()][\dAB]/g, "")
    .replace(/\x1b[=>78Mc]/g, "");
}

/**
 * Parse a captured /usage frame into plan utilization. The TUI positions text
 * with absolute-column cursor moves, so after ANSI stripping words run together
 * (e.g. "Current session" → "Currentsession"). We therefore match against a
 * whitespace-collapsed form: the labels, percentages and reset strings carry no
 * internal whitespace that matters. Returns null when neither window is found.
 */
export function parseUsageFrame(
  frame: string,
  now: number = Date.now(),
): Omit<PlanUtilization, "probedAt"> | null {
  // Collapse ALL whitespace away so column-positioned words become contiguous.
  const compact = stripAnsi(frame).replace(/\s+/g, "");

  const fiveHour = matchWindow(compact, /Current(?:session|5[-]?hour(?:limit)?|5hr)/i, now);
  const sevenDay = matchWindow(
    compact,
    /Currentweek(?:\(allmodels\))?/i,
    now,
  );

  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, status: deriveStatus(fiveHour, sevenDay) };
}

/**
 * From the index of a window label, pull the first "NN%used" and the following
 * "Resets …(timezone)" segment. Bars/spaces between the label and the percent
 * are skipped. Returns null when no "%used" follows the label.
 */
function matchWindow(
  compact: string,
  label: RegExp,
  now: number,
): UsageWindow | null {
  const labelMatch = label.exec(compact);
  if (!labelMatch) return null;
  const rest = compact.slice(labelMatch.index + labelMatch[0].length);

  // Percent: the first "NN%used" (the bar glyphs and trailing spaces sit between
  // the label and this). Guard against grabbing a later window's percent by only
  // scanning up to the next "Current" label.
  const scope = rest.split(/Current(?:session|week|5)/i)[0] ?? rest;
  const pctMatch = /(\d{1,3})%used/i.exec(scope);
  if (!pctMatch) return null;
  const utilizationPct = Number(pctMatch[1]);

  // Reset: "Resets <when>(<timezone>)" — capture the human time and the tz so we
  // can resolve it to an absolute epoch in that zone.
  const resetMatch = /Resets([^(]+?)\(([^)]+)\)/i.exec(scope);
  const resetAt = resetMatch ? parseResetAt(resetMatch[1] ?? "", resetMatch[2] ?? null, now) : null;

  return { utilizationPct, resetAt };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Resolve a /usage reset label to epoch ms, best-effort. The label is rendered
 * in the user's local zone (the same machine the probe runs on), so we build the
 * target in local time. Handles two shapes seen in the wild:
 *   - time-only: "12:20am", "3pm", "11:59pm"  → next occurrence of that time
 *   - dated:     "Jun1at3pm", "Jun 1"          → that calendar day (this/next year)
 * `tz` is accepted for provenance but not used to re-zone (probe is local).
 * Returns null when nothing parses.
 */
export function parseResetAt(
  raw: string,
  _tz: string | null,
  now: number = Date.now(),
): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, "");

  // Dated form: "<mon><day>[at<h>[:mm]<am|pm>]"
  const dated = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})(?:at(\d{1,2})(?::(\d{2}))?(am|pm)?)?/.exec(s);
  if (dated) {
    const month = MONTHS[dated[1] ?? ""] ?? 0;
    const day = Number(dated[2]);
    const { hour, minute } = resolveClock(dated[3], dated[4], dated[5]);
    const base = new Date(now);
    let d = new Date(base.getFullYear(), month, day, hour, minute, 0, 0);
    // If the date already passed this year, it must mean next year.
    if (d.getTime() < now - 24 * 60 * 60 * 1000) {
      d = new Date(base.getFullYear() + 1, month, day, hour, minute, 0, 0);
    }
    return d.getTime();
  }

  // Time-only form: "<h>[:mm]<am|pm>"
  const timed = /(\d{1,2})(?::(\d{2}))?(am|pm)/.exec(s);
  if (timed) {
    const { hour, minute } = resolveClock(timed[1], timed[2], timed[3]);
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    let t = d.getTime();
    if (t <= now) t += 24 * 60 * 60 * 1000; // next occurrence
    return t;
  }

  return null;
}

/** Convert a 12-hour clock (h, mm, am/pm) to 24-hour {hour, minute}; defaults to midnight. */
function resolveClock(
  h?: string,
  mm?: string,
  mer?: string,
): { hour: number; minute: number } {
  if (!h) return { hour: 0, minute: 0 };
  let hour = parseInt(h, 10) % 24;
  const minute = mm ? parseInt(mm, 10) : 0;
  const m = mer?.toLowerCase();
  if (m === "pm" && hour < 12) hour += 12;
  if (m === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

/** ok below 80%, warning from 80%, limit at/above 100% — by the worst window. */
function deriveStatus(
  ...windows: (UsageWindow | null)[]
): "ok" | "warning" | "limit" {
  const max = Math.max(
    0,
    ...windows.filter((w): w is UsageWindow => !!w).map((w) => w.utilizationPct),
  );
  if (max >= 100) return "limit";
  if (max >= 80) return "warning";
  return "ok";
}

// --- live probe + cache -----------------------------------------------------

let cached: PlanUtilization | null = null;
let inFlight: Promise<PlanUtilization | null> | null = null;

/** The last successful probe, or null if none yet. Never spawns anything. */
export function getCachedPlanUtilization(): PlanUtilization | null {
  return cached;
}

/**
 * Probe lazily: return the cached result immediately if it's fresh (within the
 * TTL) or a probe is already running; otherwise spawn one. `force` bypasses the
 * TTL (still deduped against an in-flight probe). Never throws — resolves to the
 * cache (possibly null) on any failure. Disabled entirely by
 * CONAN_DISABLE_USAGE_PROBE (used by tests/CI so no real claude is launched).
 */
export async function maybeProbe(opts: { force?: boolean } = {}): Promise<PlanUtilization | null> {
  if (process.env.CONAN_DISABLE_USAGE_PROBE === "1") return cached;
  const fresh = cached && Date.now() - cached.probedAt < PROBE_TTL_MS;
  if (fresh && !opts.force) return cached;
  if (inFlight) return inFlight;

  inFlight = probeUsage()
    .then((result) => {
      if (result) cached = result;
      return cached;
    })
    .catch(() => cached)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Spawn a controlled, short-lived `claude` pty, send `/usage`, capture the
 * rendered frame and parse it. Bounded by PROBE_TIMEOUT_MS and killed as soon as
 * a parseable frame appears (or the deadline hits) — no stray ptys. Resolves to
 * the parsed PlanUtilization or null; never rejects.
 */
export function probeUsage(): Promise<PlanUtilization | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? "/bin/zsh";
    let term: pty.IPty;
    let buf = "";
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let sendTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (result: PlanUtilization | null) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (sendTimer) clearTimeout(sendTimer);
      clearTimeout(deadline);
      try {
        term.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const deadline = setTimeout(() => {
      // Final attempt to salvage whatever rendered before giving up.
      const parsed = parseUsageFrame(buf);
      cleanup(parsed ? { ...parsed, probedAt: Date.now() } : null);
    }, PROBE_TIMEOUT_MS);

    try {
      term = pty.spawn(shell, ["-l", "-c", CLAUDE_BIN], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.env.HOME ?? process.cwd(),
        env: ptyEnv(),
      });
    } catch {
      cleanup(null);
      return;
    }

    term.onData((d) => {
      buf += d;
    });
    term.onExit(() => {
      const parsed = parseUsageFrame(buf);
      cleanup(parsed ? { ...parsed, probedAt: Date.now() } : null);
    });

    // Let claude boot, send /usage, then poll the buffer until both windows
    // render (or the deadline fires).
    sendTimer = setTimeout(() => {
      try {
        term.write("/usage\r");
      } catch {
        /* fall through to deadline */
      }
      pollTimer = setInterval(() => {
        const parsed = parseUsageFrame(buf);
        if (parsed && parsed.fiveHour && parsed.sevenDay) {
          cleanup({ ...parsed, probedAt: Date.now() });
        }
      }, 500);
    }, 5_000);
  });
}

/** Clean string env for the probe pty (drops undefined values; forces a real TERM). */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
