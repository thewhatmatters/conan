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

  return { found: true, sessionId, path: file, messages };
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
}

/** Coerce a usage field to a non-negative integer, defaulting to 0. */
function usageInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
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

  let latest: ContextUsage | null = null;
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
  return latest;
}
