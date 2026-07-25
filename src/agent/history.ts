import { readTranscript, type TranscriptMessage } from "../transcript/index.js";

/**
 * Chat-history adapter (US-015): reconstruct a saved thread's transcript from
 * Claude Code's own JSONL session record, shaped like the live `AgentEvent`
 * fold the UI already renders — user / assistant / reasoning items plus tool
 * cards with their results merged in by tool_use id. No message content lives
 * in Conan's DB (chat_thread is metadata only); this read IS the history.
 */

/** One reconstructed transcript entry, mirroring the UI's ChatItem roles. */
export type HistoryItem =
  | { role: "user"; text: string; ts?: number | null }
  | { role: "assistant"; text: string; ts?: number | null }
  | { role: "reasoning"; text: string; ts?: number | null }
  | {
      role: "tool";
      id: string;
      name: string;
      input: unknown;
      result: string | null;
      isError: boolean;
      ts?: number | null;
    };

export interface ChatHistory {
  /** Whether the session's JSONL was found — false degrades the UI to
   *  metadata-only (the thread still opens; a new turn starts fresh). */
  found: boolean;
  items: HistoryItem[];
}

/** Injected user-content markers that aren't the user's own words — slash
 *  command echoes, hook stdout, and system reminders ride the transcript as
 *  user messages and would render as fake bubbles. */
const META_USER_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<system-reminder>",
  "Caveat: The messages below",
];

function isMetaUserText(text: string): boolean {
  const t = text.trimStart();
  return META_USER_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Read and adapt a session's transcript. Tool results (which arrive as
 * tool_result blocks on later user messages) merge into their originating
 * tool item; an unmatched result is dropped rather than rendered orphaned.
 */
export function readChatHistory(
  sessionId: string,
  cwd?: string | null,
): ChatHistory {
  const t = readTranscript(sessionId, cwd);
  if (!t.found) return { found: false, items: [] };
  return { found: true, items: adaptMessages(t.messages) };
}

/** Pure adapter over normalized transcript messages — split out for tests. */
export function adaptMessages(messages: TranscriptMessage[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const toolIndex = new Map<string, number>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "text") {
        if (m.role === "user") {
          if (!isMetaUserText(b.text)) items.push({ role: "user", text: b.text, ts: m.ts });
        } else if (m.role === "assistant") {
          items.push({ role: "assistant", text: b.text, ts: m.ts });
        }
      } else if (b.type === "thinking") {
        if (m.role === "assistant") items.push({ role: "reasoning", text: b.text, ts: m.ts });
      } else if (b.type === "tool_use") {
        const id = b.id ?? `tool-${items.length}`;
        toolIndex.set(id, items.length);
        items.push({
          role: "tool",
          id,
          name: b.name,
          input: b.input,
          result: null,
          isError: false,
          ts: m.ts,
        });
      } else if (b.type === "tool_result") {
        const idx = b.toolUseId != null ? toolIndex.get(b.toolUseId) : undefined;
        if (idx != null) {
          const card = items[idx] as Extract<HistoryItem, { role: "tool" }>;
          items[idx] = { ...card, result: b.text, isError: b.isError };
        }
      }
    }
  }
  return items;
}
