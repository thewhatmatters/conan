import type { ChatItem } from "../hooks/useAgentChat.ts";

/** A run of this many consecutive tool cards or more folds into a Work Log
 *  group (roll-up). Shorter runs render inline — collapsing 1–2 cards isn't
 *  worth the disclosure. */
export const WORKLOG_MIN_RUN = 3;

export type ToolItem = Extract<ChatItem, { role: "tool" }>;

export type RenderChunk =
  | { kind: "single"; item: ChatItem }
  | { kind: "group"; id: string; tools: ToolItem[] };

/**
 * Fold maximal runs of consecutive tool items into Work Log groups; any
 * non-tool item (assistant narration, result, error, …) breaks a run. Runs
 * shorter than WORKLOG_MIN_RUN stay as individual `single` chunks. A group's
 * `id` is its first tool's id — stable across re-renders so the group keeps
 * its expand/collapse state while more tools stream in.
 */
export function chunkTranscript(items: ChatItem[]): RenderChunk[] {
  const chunks: RenderChunk[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= WORKLOG_MIN_RUN && run[0]) {
      chunks.push({ kind: "group", id: run[0].id, tools: run });
    } else {
      for (const t of run) chunks.push({ kind: "single", item: t });
    }
    run = [];
  };
  for (const it of items) {
    if (it.role === "tool") run.push(it);
    else {
      flush();
      chunks.push({ kind: "single", item: it });
    }
  }
  flush();
  return chunks;
}
