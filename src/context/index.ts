// US-009: capture the REAL `/context` breakdown for a live, correlated Claude
// session. `/context` is session-specific — it reports the exact model, the
// total/window token split, and the per-category usage (System prompt, System
// tools, MCP tools, Memory files, Skills, Messages, and Free space) for *that*
// conversation. It can't come from a throwaway probe (like /usage windows can),
// so it must be scraped from the live pty the session runs in.
//
// This module owns two halves:
//   - a PURE, exported parser (parseContextFrame) that turns a captured /context
//     TUI frame into a typed breakdown — unit-tested against a sample frame in
//     scripts/test-context.mjs, mirroring parseUsageFrame in src/usage/probe.ts;
//   - a tiny per-session cache the terminal layer fills passively (when a user
//     runs /context themselves) or on demand (the widget's Refresh injects it).
//
// Nothing here throws — failures resolve to null and the widget falls back to the
// on-disk estimate (src/widgets/readContextBreakdown).

import { stripAnsi } from "../usage/probe.js";

/** The categories the /context frame breaks the window into (US-009). */
export type ContextCaptureKey =
  | "system"
  | "tools"
  | "mcp"
  | "memory"
  | "skills"
  | "messages"
  | "free";

/** One parsed category row: its token count and share of the context window. */
export interface ContextCaptureCategory {
  key: ContextCaptureKey;
  label: string;
  tokens: number;
  /** Percent of the context window this category occupies, as rendered. */
  pct: number;
}

/** A parsed /context frame for one session (provenance: the correlated pty). */
export interface ContextCapture {
  /** Model slug from the header, e.g. "claude-opus-4-7", or null. */
  model: string | null;
  /** Friendly model name derived from the slug, or null. */
  modelDisplay: string | null;
  /** Total tokens consumed in the window (null when unparseable). */
  usedTokens: number | null;
  /** Context-window size in tokens (null when unparseable). */
  windowTokens: number | null;
  /** Percent of the window used, as rendered by /context (null when absent). */
  usedPct: number | null;
  /** Per-category breakdown, in the order /context lists them. */
  categories: ContextCaptureCategory[];
  /** When this frame was captured (epoch ms). */
  capturedAt: number;
}

/** Each category's label + the regex (against the whitespace-collapsed frame). */
const CATEGORIES: { key: ContextCaptureKey; label: string; re: RegExp }[] = [
  { key: "system", label: "System prompt", re: /Systemprompt:([\d.]+[km]?)tokens?\(([\d.]+)%\)/i },
  { key: "tools", label: "System tools", re: /Systemtools:([\d.]+[km]?)tokens?\(([\d.]+)%\)/i },
  { key: "mcp", label: "MCP tools", re: /MCPtools:([\d.]+[km]?)tokens?\(([\d.]+)%\)/i },
  { key: "memory", label: "Memory files", re: /Memoryfiles:([\d.]+[km]?)tokens?\(([\d.]+)%\)/i },
  { key: "skills", label: "Skills", re: /Skills:([\d.]+[km]?)tokens?\(([\d.]+)%\)/i },
  { key: "messages", label: "Messages", re: /Messages:([\d.]+[km]?)tokens?\(([\d.]+)%\)/i },
  // Free space sometimes renders without the literal "tokens" word.
  { key: "free", label: "Free space", re: /Freespace:([\d.]+[km]?)(?:tokens?)?\(([\d.]+)%\)/i },
];

/** Parse a "2.4k" / "168k" / "1.2m" / "450" token figure into an integer. */
function parseTokenCount(raw: string): number {
  const m = /^([\d.]+)([km]?)$/i.exec(raw.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Friendly display name from a model slug (best-effort; null when unknown).
 * "claude-opus-4-7" → "Claude Opus 4.7"; appends " (1M)" when the window is the
 * 1M-context variant (the slug carries no "1m" marker — /context shows it only in
 * the header text — so we infer it from the parsed window size too).
 */
function modelDisplayFor(slug: string | null, windowTokens: number | null): string | null {
  if (!slug) return null;
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(slug);
  if (!m) return null;
  const fam = (m[1] ?? "").toLowerCase();
  const family = fam.charAt(0).toUpperCase() + fam.slice(1);
  const version = m[3] ? `${m[2]}.${m[3]}` : (m[2] ?? "");
  const oneM = /1m/i.test(slug) || (windowTokens != null && windowTokens >= 1_000_000);
  return `Claude ${family} ${version}${oneM ? " (1M)" : ""}`.trim();
}

/**
 * Parse a captured /context frame into a typed breakdown. Like parseUsageFrame,
 * the TUI positions text with absolute-column moves and a two-column layout (a
 * glyph grid on the left, the labels on the right), so after ANSI stripping we
 * collapse ALL whitespace and match the labels — which carry no internal
 * whitespace that matters — anywhere in the contiguous run. Returns null when no
 * category and no token total can be found (so random terminal output is ignored).
 */
export function parseContextFrame(
  frame: string,
): Omit<ContextCapture, "capturedAt"> | null {
  const all = stripAnsi(frame).replace(/\s+/g, "");
  // Anchor on the "Context Usage" title so the startup banner ("Claude Code
  // vX.Y.Z") and earlier scrollback can't contaminate the model/total match.
  const anchor = all.search(/ContextUsage/i);
  const compact = anchor >= 0 ? all.slice(anchor) : all;

  // Total: "<used>/<window> tokens (NN%)" in the header.
  const totalMatch = /([\d.]+[km]?)\/([\d.]+[km]?)tokens?\(([\d.]+)%\)/i.exec(compact);
  const usedTokens = totalMatch ? parseTokenCount(totalMatch[1] ?? "") : null;
  const windowTokens = totalMatch ? parseTokenCount(totalMatch[2] ?? "") : null;
  const usedPct = totalMatch ? Number(totalMatch[3]) : null;

  // Model slug: the "claude-…" run in the header. /context renders no bracket
  // suffix on the slug (the "1M context" marker shows only as display text), so
  // the slug ends at the first non-slug char. Family is any word ("fable",
  // "opus", …) so new model lines parse without a code change; the required
  // leading digit keeps non-model runs like "claude-in-chrome" out.
  const modelMatch = /claude-[a-z]+-\d[\d-]*/i.exec(compact);
  const model = modelMatch ? modelMatch[0].replace(/-+$/, "") : null;

  const categories: ContextCaptureCategory[] = [];
  for (const { key, label, re } of CATEGORIES) {
    const m = re.exec(compact);
    if (!m) continue;
    categories.push({
      key,
      label,
      tokens: parseTokenCount(m[1] ?? ""),
      pct: Number(m[2]),
    });
  }

  if (categories.length === 0 && usedTokens == null) return null;

  return {
    model,
    modelDisplay: modelDisplayFor(model, windowTokens),
    usedTokens,
    windowTokens,
    usedPct,
    categories,
  };
}

// --- per-session cache ------------------------------------------------------

const cache = new Map<string, ContextCapture>();

/** The last captured /context frame for a session, or null if none. */
export function getCapturedContext(sessionId: string): ContextCapture | null {
  return cache.get(sessionId) ?? null;
}

/** Cache a parsed frame for a session, stamping the capture time. */
export function cacheCapturedContext(
  sessionId: string,
  parsed: Omit<ContextCapture, "capturedAt">,
): void {
  cache.set(sessionId, { ...parsed, capturedAt: Date.now() });
}

/** Drop a session's cached frame (e.g. when its pty exits). */
export function clearCapturedContext(sessionId: string): void {
  cache.delete(sessionId);
}
