import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHistory, HistoryItem } from "./history.js";

/**
 * Grok chat-history adapter — the Grok counterpart to `history.ts` (Claude) and
 * `codexHistory.ts` (Codex). Grok stores each session as a DIRECTORY under
 * `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<session_id>/`, whose
 * `chat_history.jsonl` is the transcript. `--resume` reuses the original
 * session id (only `--fork-session` makes a new one, which the driver never
 * passes), so later turns append to that same file — one file is the whole
 * conversation.
 *
 * Unlike Claude and Codex, Grok's `reasoning` records carry a READABLE
 * `summary_text`, which is why GROK_CAPABILITIES.reasoningText is true — so
 * reasoning rows are emitted here rather than skipped.
 */

interface GrokTextBlock {
  type?: string;
  text?: string;
}

interface GrokLine {
  type?: string;
  /** user → array of blocks; assistant → plain string. */
  content?: GrokTextBlock[] | string;
  /** reasoning summary blocks (readable, unlike Claude/Codex). */
  summary?: GrokTextBlock[];
  /** assistant tool calls ride the assistant message itself. */
  tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
  /** tool_result correlation key. */
  tool_call_id?: string;
}

/** Grok wraps the real prompt in <user_query>…</user_query>; everything else
 *  injected into the user role is context Grok added, not the user's words. */
const USER_QUERY_RE = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/;
const META_USER_PREFIXES = ["<user_info>", "<system-reminder>", "<environment"];

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

/**
 * Locate a session's `chat_history.jsonl`. The cwd-keyed directory name is
 * `encodeURIComponent(cwd)`, so with a cwd this is a direct hit; without one
 * (or on a mismatch — e.g. the thread moved) it falls back to a one-level scan
 * for a directory named after the session id.
 */
export function findGrokHistoryFile(
  sessionId: string,
  cwd?: string | null,
): string | null {
  // Reject anything that isn't a plain session id — this value reaches a path.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const root = path.join(grokHome(), "sessions");
  if (!fs.existsSync(root)) return null;

  const direct = cwd
    ? path.join(root, encodeURIComponent(cwd), sessionId, "chat_history.jsonl")
    : null;
  if (direct && fs.existsSync(direct)) return direct;

  let cwdDirs: fs.Dirent[];
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of cwdDirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(root, d.name, sessionId, "chat_history.jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Pure adapter over parsed chat_history lines — split out for tests. */
export function adaptGrokHistory(lines: GrokLine[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const line of lines) {
    const t = line.type;

    if (t === "user") {
      const text = blocksToText(line.content).trim();
      if (!text) continue;
      const q = USER_QUERY_RE.exec(text);
      if (q) {
        // The real prompt, unwrapped from its <user_query> envelope.
        if (q[1]) items.push({ role: "user", text: q[1] });
      } else if (!isMetaUserText(text)) {
        items.push({ role: "user", text });
      }
      continue;
    }

    if (t === "assistant") {
      const text = blocksToText(line.content).trim();
      if (text) items.push({ role: "assistant", text });
      // Tool calls ride the assistant message (there is no separate
      // tool_call record), and their results arrive later as tool_result.
      for (const call of line.tool_calls ?? []) {
        const id = call.id ?? `tool-${items.length}`;
        toolIndex.set(id, items.length);
        items.push({
          role: "tool",
          id,
          name: call.name ?? "tool",
          input: parseArgs(call.arguments),
          result: null,
          isError: false,
        });
      }
      continue;
    }

    if (t === "reasoning") {
      const text = blocksToText(line.summary).trim();
      if (text) items.push({ role: "reasoning", text });
      continue;
    }

    if (t === "tool_result") {
      const idx = line.tool_call_id != null ? toolIndex.get(line.tool_call_id) : undefined;
      if (idx == null) continue; // unmatched result — dropped, never orphaned
      const card = items[idx] as Extract<HistoryItem, { role: "tool" }>;
      items[idx] = { ...card, result: blocksToText(line.content) };
    }
    // `system` (and any future record type) is ignored by design.
  }
  return items;
}

/** Grok uses a plain string for assistant content and a block array for user
 *  content / reasoning summaries — normalize both. */
function blocksToText(content: GrokTextBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => b?.text ?? "").join("");
}

function isMetaUserText(text: string): boolean {
  const t = text.trimStart();
  return META_USER_PREFIXES.some((p) => t.startsWith(p));
}

function parseArgs(args: string | undefined): unknown {
  if (typeof args !== "string") return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** Read and adapt a grok session's transcript. `found:false` degrades the UI
 *  to metadata-only exactly like the Claude and Codex paths. */
export function readGrokHistory(
  sessionId: string,
  cwd?: string | null,
): ChatHistory {
  const file = findGrokHistoryFile(sessionId, cwd);
  if (!file) return { found: false, items: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { found: false, items: [] };
  }
  const lines: GrokLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l) as GrokLine);
    } catch {
      // A history being appended to can end mid-line — skip, don't fail.
    }
  }
  return { found: true, items: adaptGrokHistory(lines) };
}
