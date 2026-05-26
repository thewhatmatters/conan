// US-015: prompt-history — search the user's Claude Code prompt history.
//
// Source (overridable for tests via CONAN_CLAUDE_DIR):
//   ~/.claude/history.jsonl — one JSON object per line, appended oldest-first:
//     { display, pastedContents, timestamp (epoch ms), project (cwd) }
//
// We surface only the safe fields [{display, timestamp, project}] (pastedContents
// can be large/binary and isn't useful here), newest-first, with optional
// case-insensitive text search over `display`, a project filter (substring), and
// limit/offset pagination. `total` reflects the matched set before pagination.
//
// The file can be large (thousands of lines), so we read it line-by-line via a
// streaming reader and cap how many lines we scan (MAX_SCAN) rather than loading
// and parsing the whole thing eagerly. Missing file / malformed lines degrade to
// an empty result — never throws.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { HOME } from "../paths.js";

/** One prompt-history entry (safe subset). */
export interface PromptHistoryEntry {
  display: string;
  /** Epoch ms, or null when absent/unparseable. */
  timestamp: number | null;
  /** The cwd the prompt was issued in, or null. */
  project: string | null;
}

export interface PromptHistoryResult {
  entries: PromptHistoryEntry[];
  /** Count of entries matching the filters, before limit/offset. */
  total: number;
  limit: number;
  offset: number;
}

/** Upper bound on lines scanned from the tail of the file. */
const MAX_SCAN = 20000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The history.jsonl path (overridable for tests via CONAN_CLAUDE_DIR). */
function historyPath(claudeDir?: string): string {
  const dir = claudeDir ?? process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
  return path.join(dir, "history.jsonl");
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export interface ReadPromptHistoryOptions {
  /** Override ~/.claude (tests). */
  claudeDir?: string;
  /** Case-insensitive substring filter over `display`. */
  q?: string;
  /** Substring filter over `project` (cwd). */
  project?: string;
  /** Page size; clamped to [1, MAX_LIMIT]; defaults to DEFAULT_LIMIT. */
  limit?: number;
  /** Page offset into the matched set; clamped to >= 0. */
  offset?: number;
}

/**
 * Read + filter + paginate the prompt history, newest-first. Missing file or
 * malformed lines degrade gracefully — never throws.
 */
export async function readPromptHistory(
  opts: ReadPromptHistoryOptions = {},
): Promise<PromptHistoryResult> {
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const needle = opts.q?.toLowerCase().trim() || null;
  const projNeedle = opts.project?.trim() || null;

  const file = historyPath(opts.claudeDir);

  // Parse every line into an entry (append-order, oldest-first), capped at the
  // last MAX_SCAN lines so a runaway file can't pin memory.
  const all: PromptHistoryEntry[] = [];
  try {
    if (!fs.existsSync(file)) return { entries: [], total: 0, limit, offset };
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        const v = JSON.parse(trimmed);
        if (!v || typeof v !== "object") continue;
        obj = v as Record<string, unknown>;
      } catch {
        continue;
      }
      const display = str(obj.display);
      if (display === null) continue;
      const ts = typeof obj.timestamp === "number" ? obj.timestamp : null;
      all.push({ display, timestamp: ts, project: str(obj.project) });
      // Keep only the most recent MAX_SCAN entries.
      if (all.length > MAX_SCAN) all.shift();
    }
  } catch {
    return { entries: [], total: 0, limit, offset };
  }

  // Newest-first.
  all.reverse();

  const matched = all.filter((e) => {
    if (needle && !e.display.toLowerCase().includes(needle)) return false;
    if (projNeedle && !(e.project ?? "").includes(projNeedle)) return false;
    return true;
  });

  return {
    entries: matched.slice(offset, offset + limit),
    total: matched.length,
    limit,
    offset,
  };
}
