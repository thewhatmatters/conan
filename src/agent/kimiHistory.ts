import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHistory, HistoryItem } from "./history.js";

/**
 * Kimi chat-history adapter — the Kimi counterpart to `history.ts` (Claude),
 * `codexHistory.ts` (Codex), and `grokHistory.ts` (Grok).
 *
 * Kimi persists each session as a DIRECTORY under
 * `~/.kimi-code/sessions/wd_<basename>_<hash>/<session_id>/`, whose
 * `agents/main/wire.jsonl` is the transcript. The `wd_` shard carries a hash of
 * the working directory that we cannot recompute, so the session directory is
 * resolved through kimi's own `~/.kimi-code/session_index.jsonl` (one JSON
 * object per session: `sessionId`, `sessionDir`, `workDir`) instead of being
 * derived — that index IS the lookup table, which is why this reader needs no
 * cwd where the Grok one does.
 *
 * Until this existed the reader was a stub returning `found:false`, so every
 * reopened Kimi thread showed the "history couldn't be found" banner AND —
 * because both shells gate `--resume` on the history being found (`ChatPane`'s
 * `canResume`, `useV2ThreadHistory`'s `resumeSessionId`) — silently started a
 * fresh session, dropping the model's context.
 *
 * Unlike the live `kimi -p --output-format stream-json` stream, which carries
 * no reasoning at all (hence KIMI_CAPABILITIES.reasoningText: false), the
 * on-disk wire log DOES carry readable `think` parts. They become `reasoning`
 * items here exactly as `history.ts` does for Claude: the reader stays faithful
 * to what the provider stored, and the one gate stays where it already is
 * (`ChatPane` renders reasoning only when `caps.reasoningText`).
 */

/** Wire-log line shapes we care about; everything else is ignored by design so
 *  a Kimi version bump can add record types without breaking the reader. */
interface KimiWireLine {
  type?: string;
  /** epoch ms; present on every record except `metadata`. */
  time?: number;
  /** `context.append_message` */
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    /** Why the message entered the context — see ORIGIN_USER. */
    origin?: { kind?: string };
  };
  /** `context.append_loop_event` */
  event?: KimiLoopEvent;
}

interface KimiLoopEvent {
  type?: string;
  /** `content.part` — `text` is assistant prose, `think` is reasoning. */
  part?: { type?: string; text?: string; think?: string };
  /** `tool.call` / `tool.result` correlation key. */
  toolCallId?: string;
  /** `tool.call` */
  name?: string;
  args?: unknown;
  /** `tool.result` */
  result?: { output?: unknown; isError?: boolean };
}

/**
 * Kimi tags every context message with WHY it was appended, and only `user` is
 * the person typing: `injection` is Kimi's own system-reminder text and
 * `skill_activation` is a loaded-skill envelope, both of which would render as
 * fake prompt bubbles. Filtering on that tag is structural, so unlike the
 * prefix lists the Claude/Codex/Grok readers need, it cannot be defeated by a
 * user whose message happens to start with the wrong string.
 */
const ORIGIN_USER = "user";

function kimiHome(): string {
  // Kimi 0.27.0 documents no home override of its own (checked `kimi --help`),
  // so this variable is Conan-side only: it exists so the resolver is testable
  // against a fixture tree, and so a relocated store stays readable.
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

/**
 * Locate a session's `wire.jsonl` via kimi's session index, falling back to a
 * one-level scan of the `wd_*` shards when the index is missing or stale (the
 * CLI rewrites it, so a session can exist on disk before it lands there) —
 * same belt-and-braces shape as `findGrokHistoryFile`.
 */
export function findKimiWireFile(sessionId: string): string | null {
  // Reject anything that isn't a plain session id — this value reaches a path.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const home = kimiHome();

  const indexed = sessionDirFromIndex(home, sessionId);
  if (indexed) {
    const file = path.join(indexed, "agents", "main", "wire.jsonl");
    if (fs.existsSync(file)) return file;
  }

  let shards: fs.Dirent[];
  try {
    shards = fs.readdirSync(path.join(home, "sessions"), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const file = path.join(
      home,
      "sessions",
      shard.name,
      sessionId,
      "agents",
      "main",
      "wire.jsonl",
    );
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Read `session_index.jsonl` for this session's directory. The index is
 *  authoritative for the `wd_` shard, which is a hash we can't recompute. */
function sessionDirFromIndex(home: string, sessionId: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { sessionId?: string; sessionDir?: string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // an index being rewritten can end mid-line
    }
    if (entry.sessionId === sessionId && typeof entry.sessionDir === "string") {
      return entry.sessionDir;
    }
  }
  return null;
}

/** Pure adapter over parsed wire-log lines — split out for tests. */
export function adaptKimiHistory(lines: KimiWireLine[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const line of lines) {
    const ts = typeof line.time === "number" ? line.time : null;

    // The user's own prompt. A `turn.prompt` record carries the same text one
    // line earlier; reading only the context message keeps every prompt single.
    if (line.type === "context.append_message") {
      const m = line.message;
      if (!m || m.role !== "user" || m.origin?.kind !== ORIGIN_USER) continue;
      const text = blocksToText(m.content).trim();
      if (text) items.push({ role: "user", text, ts });
      continue;
    }

    if (line.type !== "context.append_loop_event") continue;
    const e = line.event;
    if (!e) continue;

    if (e.type === "content.part") {
      if (e.part?.type === "text") {
        const text = (e.part.text ?? "").trim();
        if (text) items.push({ role: "assistant", text, ts });
      } else if (e.part?.type === "think") {
        const text = (e.part.think ?? "").trim();
        if (text) items.push({ role: "reasoning", text, ts });
      }
      continue;
    }

    if (e.type === "tool.call") {
      const id = e.toolCallId ?? `tool-${items.length}`;
      toolIndex.set(id, items.length);
      items.push({
        role: "tool",
        id,
        name: e.name ?? "tool",
        input: e.args ?? {},
        result: null,
        isError: false,
        ts,
      });
      continue;
    }

    if (e.type === "tool.result") {
      const idx = e.toolCallId != null ? toolIndex.get(e.toolCallId) : undefined;
      if (idx == null) continue; // unmatched result — dropped, never orphaned
      const card = items[idx] as Extract<HistoryItem, { role: "tool" }>;
      items[idx] = {
        ...card,
        result: outputToText(e.result?.output),
        isError: e.result?.isError === true,
      };
    }
    // step.begin/step.end and every other loop event are ignored by design.
  }
  return items;
}

/** Kimi user content is always a block array; assistant prose rides
 *  `content.part` instead, so this only ever normalizes user messages. */
function blocksToText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content.map((b) => b?.text ?? "").join("");
}

/** Tool output is a string in practice; anything else is stringified rather
 *  than rendered as "[object Object]". */
function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Read and adapt a kimi session's transcript. `found:false` degrades the UI
 *  to metadata-only exactly like the Claude, Codex, and Grok paths. */
export function readKimiHistory(sessionId: string): ChatHistory {
  const file = findKimiWireFile(sessionId);
  if (!file) return { found: false, items: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { found: false, items: [] };
  }
  const lines: KimiWireLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l) as KimiWireLine);
    } catch {
      // A wire log being appended to can end mid-line — skip, don't fail.
    }
  }
  return { found: true, items: adaptKimiHistory(lines) };
}
