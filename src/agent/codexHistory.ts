import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatHistory, HistoryItem } from "./history.js";

/**
 * Codex chat-history adapter — the Codex counterpart to `history.ts` (which
 * reads Claude's JSONL). Codex persists every session as a "rollout" JSONL
 * under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`, and
 * `codex exec resume` APPENDS later turns to that same file — so one file is
 * the whole conversation.
 *
 * Without this, reopening a codex thread found no transcript and degraded to a
 * fresh session (context lost). The conversation was never gone — Conan just
 * couldn't read Codex's format.
 */

/** Rollout line shapes we care about; everything else is ignored by design so
 *  a Codex version bump can add record types without breaking the reader. */
interface RolloutLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    /** function_call / custom_tool_call */
    name?: string;
    arguments?: string;
    input?: string;
    call_id?: string;
    /** function_call_output / custom_tool_call_output */
    output?: unknown;
  };
}

/** Injected user-content Codex adds itself — not the user's words. Rendering
 *  these would show fake prompt bubbles (same problem Claude's reader solves
 *  with META_USER_PREFIXES). */
const META_USER_PREFIXES = [
  "<recommended_plugins>",
  "<environment_context>",
  "<user_instructions>",
  "# AGENTS.md instructions",
];

function isMetaUserText(text: string): boolean {
  const t = text.trimStart();
  return META_USER_PREFIXES.some((p) => t.startsWith(p));
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Locate a session's rollout file. The session id Codex reports as
 * `thread.started.thread_id` (what Conan persists) is embedded in the
 * filename, so this is a bounded walk of the date-sharded sessions tree
 * rather than a content scan.
 */
export function findCodexRollout(sessionId: string): string | null {
  // Reject anything that isn't a plain session id — this value reaches a path.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const root = path.join(codexHome(), "sessions");
  if (!fs.existsSync(root)) return null;

  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.includes(sessionId)) {
        return full;
      }
    }
  }
  return null;
}

/** Pure adapter over parsed rollout lines — split out for tests. */
export function adaptRollout(lines: RolloutLine[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const line of lines) {
    if (line.type !== "response_item") continue;
    const p = line.payload;
    if (!p) continue;

    if (p.type === "message") {
      // `developer` carries sandbox/permission instructions — never the user.
      if (p.role !== "user" && p.role !== "assistant") continue;
      const text = (p.content ?? [])
        .map((c) => c.text ?? "")
        .join("")
        .trim();
      if (!text) continue;
      if (p.role === "user") {
        if (!isMetaUserText(text)) items.push({ role: "user", text });
      } else {
        items.push({ role: "assistant", text });
      }
      continue;
    }

    // Codex's `reasoning` records carry `encrypted_content` with an empty
    // summary — no readable thought text (verified across every local
    // rollout), which is why CODEX_CAPABILITIES.reasoningText is false. Any
    // reasoning row here would render blank, so they're skipped.

    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const id = p.call_id ?? `tool-${items.length}`;
      toolIndex.set(id, items.length);
      items.push({
        role: "tool",
        id,
        name: p.name ?? "tool",
        input: parseInput(p),
        result: null,
        isError: false,
      });
      continue;
    }

    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const idx = p.call_id != null ? toolIndex.get(p.call_id) : undefined;
      if (idx == null) continue; // unmatched result — dropped, never orphaned
      const card = items[idx] as Extract<HistoryItem, { role: "tool" }>;
      items[idx] = { ...card, result: stringifyOutput(p.output) };
    }
  }
  return items;
}

/** function_call carries JSON-string `arguments`; custom_tool_call a raw
 *  `input` string (e.g. an apply_patch body). */
function parseInput(p: NonNullable<RolloutLine["payload"]>): unknown {
  if (typeof p.arguments === "string") {
    try {
      return JSON.parse(p.arguments);
    } catch {
      return p.arguments;
    }
  }
  return p.input ?? {};
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Read and adapt a codex session's rollout. `found:false` degrades the UI to
 *  metadata-only exactly like the Claude path. */
export function readCodexHistory(sessionId: string): ChatHistory {
  const file = findCodexRollout(sessionId);
  if (!file) return { found: false, items: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { found: false, items: [] };
  }
  const lines: RolloutLine[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l) as RolloutLine);
    } catch {
      // A rollout being appended to can end mid-line — skip, don't fail.
    }
  }
  return { found: true, items: adaptRollout(lines) };
}
