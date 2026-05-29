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
  /** Current week, Sonnet-only window (US-010); null on plans that don't show it. */
  sevenDaySonnet: UsageWindow | null;
  /** Overall posture derived from the windows: ok < 80% ≤ warning < 100% ≤ limit. */
  status: "ok" | "warning" | "limit";
  /** When this frame was captured (epoch ms). */
  probedAt: number;
}

/**
 * One "What's contributing to your limits usage?" insight (US-007). Each is an
 * approximate attribution the /usage screen prints, e.g. headlinePct=73,
 * factor="of your usage came from sessions active for 8+ hours", with an
 * explanatory advice line. Parsed generically — count + phrasing vary.
 */
export interface UsageInsight {
  /** The leading percentage of the headline (0–100). */
  headlinePct: number;
  /** The headline text after the percent (the contributing factor). */
  factor: string;
  /** The explanatory/advice line(s) below the headline; "" when none. */
  advice: string;
}

/** One row of the "Skills · % of usage" table (US-007): skill name + percent. */
export interface UsageSkill {
  /** Skill name with any leading "/" stripped, e.g. "automate-browser". */
  name: string;
  /** Percent of usage attributed to this skill (0–100). */
  pct: number;
}

/** Per-model token usage from the /usage Session block (US-010). */
export interface ModelUsage {
  /** Model slug, e.g. "claude-opus-4-7", or null for the aggregate "Usage:" line. */
  model: string | null;
  /** Friendly model name derived from the slug, or null. */
  modelDisplay: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * The SESSION-specific block of the /usage screen (US-010): the running cost,
 * API/wall durations, code changes, and per-model token usage for *this*
 * conversation. Account-global windows live in PlanUtilization; this block can
 * only come from a live, correlated pty (a throwaway probe has no real session).
 */
export interface UsageSession {
  /** Total session cost in USD, or null when unparseable. */
  totalCostUsd: number | null;
  /** API duration in ms (the "Total duration (API)" line), or null. */
  apiDurationMs: number | null;
  /** Wall-clock duration in ms (the "Total duration (wall)" line), or null. */
  wallDurationMs: number | null;
  /** Lines added (from "Total code changes"), or null. */
  linesAdded: number | null;
  /** Lines removed (from "Total code changes"), or null. */
  linesRemoved: number | null;
  /** Per-model token usage; one aggregate entry (model=null) when no breakdown. */
  byModel: ModelUsage[];
}

/**
 * A full /usage capture from a live pty (US-010): the session-specific block plus
 * all three account-global windows, parsed from one rendered frame. Cached per
 * session by the terminal layer and surfaced (more accurate than the throwaway
 * probe) by the usage route when present.
 */
export interface LiveUsage {
  session: UsageSession | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
  status: "ok" | "warning" | "limit";
  /** "What's contributing" attributions parsed from the frame (US-007); [] when absent. */
  insights: UsageInsight[];
  /** "Skills · % of usage" rows parsed from the frame (US-007); [] when absent. */
  skills: UsageSkill[];
  /** When this frame was captured (epoch ms). */
  capturedAt: number;
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
  // US-010: the third window — Current week, Sonnet only. Anchored on its own
  // "(Sonnetonly)" label so it's distinct from the all-models week above.
  const sevenDaySonnet = matchWindow(compact, /Currentweek\(Sonnetonly\)/i, now);

  if (!fiveHour && !sevenDay && !sevenDaySonnet) return null;
  return {
    fiveHour,
    sevenDay,
    sevenDaySonnet,
    status: deriveStatus(fiveHour, sevenDay, sevenDaySonnet),
  };
}

/**
 * Strip ANSI then split into trimmed, single-spaced lines. Unlike the window /
 * session parsers (which collapse ALL whitespace because their labels are
 * absolute-column-positioned), the contributing-insights + skills sections are
 * naturally line-wrapped prose, so we keep line + word boundaries.
 */
function cleanLines(frame: string): string[] {
  return stripAnsi(frame)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim());
}

// The /usage stats screen is rendered with absolute-column cursor moves, so
// after ANSI stripping the *words within a line* run together ("43% of your" →
// "43%ofyour") even though the NEWLINES between rows survive. So unlike the
// fully-collapsed window/session parsers, these key off line STRUCTURE (headline
// vs advice vs table-row) but tolerate the missing intra-line spaces — every
// pattern below works whether or not a space rendered.

/** A line that ends a /usage stats section: the "d to day · w to week" footer. */
const USAGE_FOOTER = /\bto\s*day\b.*\bto\s*week\b/i;

/** The "Skills · % of usage" table header (also where the insights section ends). */
const SKILLS_HEADER = /Skills\b.*?(?:%\s*of\s*usage|·)/i;

/** The "Subagents · % of usage" table header (separate from skills; ends both sections). */
const SUBAGENTS_HEADER = /Subagents\b.*?(?:%\s*of\s*usage|·)/i;

/**
 * Parse the "What's contributing to your limits usage?" section (US-007) into a
 * list of { headlinePct, factor, advice } triples. Generic on purpose — the
 * count and phrasing vary (Claude may render zero, one, or several with
 * different thresholds), so we key off the headline shape "NN%<factor>" (the
 * space after % may not have rendered) and attach any following non-headline
 * line(s) as advice. Deduped by headline so a re-rendered frame doesn't double
 * up. Returns [] when the section is absent.
 */
export function parseUsageInsights(frame: string): UsageInsight[] {
  const lines = cleanLines(frame);
  const start = lines.findIndex((l) => /What'?s\s*contributing/i.test(l));
  if (start < 0) return [];

  // The section runs until the Skills/Subagents table, the footer, or end.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (SKILLS_HEADER.test(l) || SUBAGENTS_HEADER.test(l) || USAGE_FOOTER.test(l)) {
      end = i;
      break;
    }
  }

  const out: UsageInsight[] = [];
  const seen = new Set<string>();
  let current: UsageInsight | null = null;
  const flush = () => {
    if (!current) return;
    const key = `${current.headlinePct}|${current.factor}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(current);
    }
    current = null;
  };
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    const head = /^(\d{1,3})%\s*(.+)$/.exec(line);
    if (head) {
      flush();
      current = { headlinePct: Number(head[1]), factor: (head[2] ?? "").trim(), advice: "" };
    } else if (current) {
      // Advice line(s) for the current headline; skip the caveat boilerplate.
      if (/^Approximate|Last\s*24h|independent\s*characteristic|Scanning|Refreshing|Esc\s*to\s*cancel/i.test(line)) {
        continue;
      }
      current.advice = current.advice ? `${current.advice} ${line}` : line;
    }
    // Lines before the first headline (the caveat) are ignored (current is null).
  }
  flush();
  return out;
}

/**
 * Parse the "Skills · % of usage" table (US-007) into { name, pct } rows. Any
 * number of rows; a leading "/" on the skill name is stripped; the percent may
 * be glued to the name ("/automate-browser10%"). Stops at the Subagents table or
 * the footer (so subagents aren't counted as skills). Returns [] when absent.
 */
export function parseUsageSkills(frame: string): UsageSkill[] {
  const lines = cleanLines(frame);
  const start = lines.findIndex((l) => SKILLS_HEADER.test(l));
  if (start < 0) return [];

  const out: UsageSkill[] = [];
  const seen = new Set<string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    if (SUBAGENTS_HEADER.test(line) || USAGE_FOOTER.test(line)) break;
    // Row: "<name><pct>%" — the name's lazy class excludes digits so a glued
    // percent ("/automate-browser10%") splits cleanly; an optional space is fine.
    const m = /^\/?([A-Za-z][A-Za-z._-]*)\s*(\d{1,3})%$/.exec(line);
    if (m) out.push({ name: m[1] ?? "", pct: Number(m[2]) });
  }
  return out;
}

const MODELLESS_DURATION = /([0-9hms]+)/;

/**
 * Parse the SESSION block of a captured /usage frame (US-010): total cost,
 * API/wall durations, code changes, and per-model token usage. Like the window
 * parser, the TUI column-positions text so we strip ANSI + collapse whitespace,
 * then match the labels (which carry no internal whitespace that matters).
 * Returns null when no Session-block signal is present (so random output is
 * ignored). The session block is session-specific — only meaningful from a live
 * correlated pty, never a throwaway probe.
 */
export function parseUsageSession(frame: string): UsageSession | null {
  const compact = stripAnsi(frame).replace(/\s+/g, "");

  const cost = /Totalcost:\$([\d,]+(?:\.\d+)?)/i.exec(compact);
  const api = /Totalduration\(API\):([0-9hms.]+)/i.exec(compact);
  const wall = /Totalduration\(wall\):([0-9hms.]+)/i.exec(compact);
  const code = /Totalcodechanges:([\d,]+)linesadded,([\d,]+)linesremoved/i.exec(compact);
  const byModel = parseByModel(compact);

  const totalCostUsd = cost ? Number((cost[1] ?? "").replace(/,/g, "")) : null;
  const apiDurationMs = api ? parseDurationMs(api[1] ?? "") : null;
  const wallDurationMs = wall ? parseDurationMs(wall[1] ?? "") : null;
  const linesAdded = code ? Number((code[1] ?? "").replace(/,/g, "")) : null;
  const linesRemoved = code ? Number((code[2] ?? "").replace(/,/g, "")) : null;

  // Require at least one Session-block signal so unrelated output doesn't parse.
  if (
    totalCostUsd == null &&
    apiDurationMs == null &&
    wallDurationMs == null &&
    code == null &&
    byModel.length === 0
  ) {
    return null;
  }

  return { totalCostUsd, apiDurationMs, wallDurationMs, linesAdded, linesRemoved, byModel };
}

/**
 * Per-model usage rows from the Session block. Anchored on a "claude-…" slug so
 * the "Usage by model" header (which has no colon-delimited numbers) can't be
 * mis-captured as a model. Falls back to the single aggregate "Usage: N input, …"
 * line (e.g. a $0 session with no per-model breakdown) as one entry (model=null).
 */
function parseByModel(compact: string): ModelUsage[] {
  const out: ModelUsage[] = [];
  const re =
    /(claude-[a-z]+-[\d-]+):([\d.,]+[km]?)input,([\d.,]+[km]?)output,([\d.,]+[km]?)cacheread,([\d.,]+[km]?)cachewrite/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(compact)) !== null) {
    const model = (m[1] ?? "").replace(/-+$/, "");
    out.push({
      model,
      modelDisplay: modelDisplayFor(model),
      inputTokens: parseTokenCount(m[2] ?? ""),
      outputTokens: parseTokenCount(m[3] ?? ""),
      cacheReadTokens: parseTokenCount(m[4] ?? ""),
      cacheWriteTokens: parseTokenCount(m[5] ?? ""),
    });
  }
  if (out.length > 0) return out;

  const agg =
    /Usage:([\d.,]+[km]?)input,([\d.,]+[km]?)output,([\d.,]+[km]?)cacheread,([\d.,]+[km]?)cachewrite/i.exec(
      compact,
    );
  if (agg) {
    out.push({
      model: null,
      modelDisplay: null,
      inputTokens: parseTokenCount(agg[1] ?? ""),
      outputTokens: parseTokenCount(agg[2] ?? ""),
      cacheReadTokens: parseTokenCount(agg[3] ?? ""),
      cacheWriteTokens: parseTokenCount(agg[4] ?? ""),
    });
  }
  return out;
}

/** Parse "1.2k" / "168k" / "1.8m" / "450" / "1,234" into an integer count. */
function parseTokenCount(raw: string): number {
  const s = raw.replace(/,/g, "").trim();
  const m = /^([\d.]+)([km]?)$/i.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/** Convert a "1h2m3s" / "3m20s" / "45s" / "0s" duration string to milliseconds. */
function parseDurationMs(raw: string): number {
  if (!MODELLESS_DURATION.test(raw)) return 0;
  let ms = 0;
  const h = /(\d+)h/.exec(raw);
  if (h) ms += Number(h[1]) * 3_600_000;
  const m = /(\d+)m/.exec(raw);
  if (m) ms += Number(m[1]) * 60_000;
  const s = /(\d+)s/.exec(raw);
  if (s) ms += Number(s[1]) * 1_000;
  return ms;
}

/** Friendly display name from a model slug (best-effort; null when unknown). */
function modelDisplayFor(slug: string): string | null {
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(slug);
  if (!m) return null;
  const fam = (m[1] ?? "").toLowerCase();
  const family = fam.charAt(0).toUpperCase() + fam.slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : (m[2] ?? "");
  return `Claude ${family} ${version}`.trim();
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

// --- live /usage capture (per session, from the correlated pty) -------------
//
// US-010: the Session block is session-specific, so — like the /context capture
// (src/context/index.ts) — it can't come from the throwaway probe. The terminal
// layer fills this cache passively (when a user runs /usage) or on demand (the
// widget's Refresh injects it); the usage route reads it for the active session.

const liveCache = new Map<string, LiveUsage>();

/** The last captured /usage frame for a session, or null if none. */
export function getCapturedUsage(sessionId: string): LiveUsage | null {
  return liveCache.get(sessionId) ?? null;
}

/** Cache a parsed live /usage frame for a session, stamping the capture time. */
export function cacheCapturedUsage(
  sessionId: string,
  parsed: Omit<LiveUsage, "capturedAt">,
): void {
  liveCache.set(sessionId, { ...parsed, capturedAt: Date.now() });
}

/** Drop a session's cached live /usage frame (e.g. when its pty exits). */
export function clearCapturedUsage(sessionId: string): void {
  liveCache.delete(sessionId);
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
