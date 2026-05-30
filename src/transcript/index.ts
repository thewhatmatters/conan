import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

/**
 * Claude Code stores each session's full conversation as newline-delimited JSON
 * at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl, where the cwd is
 * encoded by replacing every "/" and "." with "-" (e.g.
 * /Users/me/Development/conan -> -Users-me-Development-conan). We read that file
 * directly for the transcript viewer (US-014) rather than duplicating it into
 * SQLite. The event store stays the source for live activity; this is the
 * canonical record for review.
 */
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

/** Encode a cwd the way Claude Code names its per-project transcript folder. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Locate a session's JSONL file. Prefers the directory derived from the known
 * cwd; falls back to scanning every project folder for <session-id>.jsonl so a
 * session whose cwd we don't have (or that moved) still resolves. Returns null
 * when no matching file exists.
 */
export function transcriptPath(sessionId: string, cwd?: string | null): string | null {
  const file = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = path.join(PROJECTS_DIR, encodeCwd(cwd), file);
    if (fs.existsSync(direct)) return direct;
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** One content block in a normalized transcript message. */
export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string | null; isError: boolean; text: string };

/** One message in the normalized transcript, in conversation order. */
export interface TranscriptMessage {
  uuid: string | null;
  /** "user" | "assistant"; a user message carrying only tool_results is "tool". */
  role: "user" | "assistant" | "tool";
  ts: number | null;
  blocks: TranscriptBlock[];
}

export interface TranscriptResult {
  /** Whether a transcript file was found and read. */
  found: boolean;
  sessionId: string;
  /** Absolute path read, or null when not found. */
  path: string | null;
  messages: TranscriptMessage[];
}

/** Flatten a tool_result's content (string, or array of text/image blocks). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        const b = c as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Normalize one assistant/user message's content into transcript blocks. */
function normalizeBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") {
    return content.length ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.length)
          out.push({ type: "text", text: b.text });
        break;
      case "thinking":
        if (typeof b.thinking === "string" && b.thinking.length)
          out.push({ type: "thinking", text: b.thinking });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          name: typeof b.name === "string" ? b.name : "tool",
          input: b.input ?? {},
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
          isError: b.is_error === true,
          text: toolResultText(b.content),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Read and normalize a session's transcript (US-014). Returns the user /
 * assistant / tool messages in order with timestamps. Lines that aren't
 * conversation messages (queue-operation, attachment, file-history-snapshot,
 * last-prompt, summary, …) and malformed JSON lines are skipped. A
 * missing/unreadable file yields { found:false, messages:[] } so the UI can show
 * an empty state rather than erroring.
 */
export function readTranscript(
  sessionId: string,
  cwd?: string | null,
): TranscriptResult {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return { found: false, sessionId, path: null, messages: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { found: false, sessionId, path: null, messages: [] };
  }

  return { found: true, sessionId, path: file, messages: normalizeTranscriptLines(raw) };
}

/**
 * Normalize the raw JSONL body of a Claude Code transcript (the main session
 * record or a subagent's agent-*.jsonl, US-014) into ordered conversation
 * messages. Lines that aren't conversation messages (queue-operation,
 * attachment, file-history-snapshot, summary, …) and malformed JSON are skipped.
 * Exported so the subagent reader can reuse the same normalization.
 */
export function normalizeTranscriptLines(raw: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const blocks = normalizeBlocks(msg.content);
    if (blocks.length === 0) continue;
    const isToolOnly =
      o.type === "user" && blocks.every((b) => b.type === "tool_result");
    messages.push({
      uuid: typeof o.uuid === "string" ? o.uuid : null,
      role: isToolOnly ? "tool" : (o.type as "user" | "assistant"),
      ts: parseTs(o.timestamp),
      blocks,
    });
  }
  return messages;
}

/** Parse an ISO timestamp string to epoch ms; null when absent/invalid. */
function parseTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * The latest assistant turn's context-window consumption (US-013). `used` is the
 * input side of that message's usage block —
 * input_tokens + cache_read_input_tokens + cache_creation_input_tokens — which is
 * what occupies the context window going into the next turn (output is not part
 * of the prompt). `model` is the slug that produced it, so the UI can derive the
 * window size (1M for *-1m variants, 200k default). This reconstructs what the
 * TUI's /context shows, since /context is a slash command with no headless feed.
 */
export interface ContextUsage {
  used: number;
  model: string | null;
  /** Context-window size the `used` count is measured against (US-013 fix). */
  windowTokens: number;
}

/** Default context window for models without the 1M-context beta. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The 1M-context-beta window. */
export const ONE_M_CONTEXT_WINDOW = 1_000_000;

/** Strip a "[variant]" suffix (e.g. "[1m]") down to the base model id. */
function baseModel(m: string | null | undefined): string {
  return (m ?? "").replace(/\[[^\]]*\]/g, "").trim();
}

/** True when a model slug marks the 1M-context variant. */
function is1mModel(m: string | null | undefined): boolean {
  return !!m && /1m/i.test(m);
}

/**
 * Resolve a session's context-window size. The "[1m]" 1M-context marker rides
 * ONLY the SessionStart hook payload — the transcript model and any session that
 * missed its SessionStart both lack it — so a bare slug would wrongly default a
 * 1M-context session to 200k (showing ~99% instead of ~20%). We treat the window
 * as 1M when any of these hold:
 *   1. the model itself is a 1m variant;
 *   2. a sibling session on the SAME base model reports 1m — the 1M beta is
 *      install-wide for that model, so an unmarked sibling is on it too;
 *   3. the measured used tokens already exceed the 200k default — impossible on
 *      a 200k window.
 * The live `/context` capture, when present, supersedes this with its parsed window.
 */
export function resolveContextWindow(
  model: string | null,
  used: number | null,
  sessionModels: (string | null)[] = [],
): number {
  if (is1mModel(model)) return ONE_M_CONTEXT_WINDOW;
  const base = baseModel(model);
  if (base && sessionModels.some((m) => is1mModel(m) && baseModel(m) === base))
    return ONE_M_CONTEXT_WINDOW;
  if (used != null && used > DEFAULT_CONTEXT_WINDOW) return ONE_M_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

/** Coerce a usage field to a non-negative integer, defaulting to 0. */
function usageInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** One assistant turn's total token consumption (v4.5-timeline post-loop). */
export interface AssistantTurnUsage {
  /** Epoch ms of the assistant message's `timestamp`. */
  ts: number;
  /** input + cache_read + cache_creation + output — the full per-turn spend.
   *  Matches what `/usage` reports. */
  totalTokens: number;
  /** Just the cache_read_input_tokens portion — the prior-context replay that
   *  typically dominates `totalTokens` (often 95–99%) without representing
   *  any new work. Pulse's footer splits this out from `new` (= totalTokens
   *  minus cacheReadTokens) so the displayed sum doesn't read as alarming
   *  cache-replay inflation. */
  cacheReadTokens: number;
}

/**
 * Walk a session's JSONL transcript and emit per-assistant-turn token totals,
 * one row per assistant message that carries a `usage` block. Returned
 * ascending by ts so the Timeline backend can match each Stop hook event to
 * the most-recent preceding assistant turn with a binary-friendly walk.
 *
 * Empty when the transcript can't be read or has no usage blocks — callers
 * just skip the badge in that case.
 */
export function readAssistantTurnUsages(
  sessionId: string,
  cwd?: string | null,
): AssistantTurnUsage[] {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AssistantTurnUsage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "assistant") continue;
    const ts = parseTs(o.timestamp);
    if (ts === null) continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const usage = (msg.usage ?? null) as Record<string, unknown> | null;
    if (!usage) continue;
    const cacheRead = usageInt(usage.cache_read_input_tokens);
    const total =
      usageInt(usage.input_tokens) +
      cacheRead +
      usageInt(usage.cache_creation_input_tokens) +
      usageInt(usage.output_tokens);
    if (total === 0) continue;
    out.push({ ts, totalTokens: total, cacheReadTokens: cacheRead });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Read the latest assistant message's usage from a session's transcript JSONL
 * and return its context consumption (US-013). Scans every assistant line and
 * keeps the last one carrying a usage block. Returns null when no transcript or
 * no usage is found, so the UI can fall back to the session's stored
 * context_tokens.
 */
export function readContextUsage(
  sessionId: string,
  cwd?: string | null,
): ContextUsage | null {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let latest: { used: number; model: string | null } | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "assistant") continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const usage = (msg.usage ?? null) as Record<string, unknown> | null;
    if (!usage) continue;
    const used =
      usageInt(usage.input_tokens) +
      usageInt(usage.cache_read_input_tokens) +
      usageInt(usage.cache_creation_input_tokens);
    if (used === 0) continue;
    latest = { used, model: typeof msg.model === "string" ? msg.model : null };
  }
  if (!latest) return null;
  // Window from this session's own model + used (the transcript model lacks the
  // "[1m]" marker, so used>200k is the main signal here); readWidgets refines it
  // with the cross-session sibling inference once it has the full session list.
  return {
    ...latest,
    windowTokens: resolveContextWindow(latest.model, latest.used),
  };
}
