import { strict as assert } from "node:assert";
import { test } from "node:test";
import { adaptMessages } from "./history.js";
import { normalizeTranscriptLines } from "../transcript/index.js";

// The adapter runs over normalizeTranscriptLines' output, so the tests feed
// raw JSONL lines shaped like Claude Code's real session records.

const line = (o: unknown): string => JSON.stringify(o);

function jsonl(...lines: unknown[]): string {
  return lines.map(line).join("\n");
}

test("adaptMessages: user + assistant text become chat items in order", () => {
  const raw = jsonl(
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-07-23T10:00:00Z",
      message: { role: "user", content: "hello there" },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-07-23T10:00:05Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "hi back" },
        ],
      },
    },
  );
  const items = adaptMessages(normalizeTranscriptLines(raw));
  assert.deepEqual(items, [
    { role: "user", text: "hello there", ts: Date.parse("2026-07-23T10:00:00Z") },
    { role: "reasoning", text: "pondering", ts: Date.parse("2026-07-23T10:00:05Z") },
    { role: "assistant", text: "hi back", ts: Date.parse("2026-07-23T10:00:05Z") },
  ]);
});

test("adaptMessages: tool_result merges into its tool card by id", () => {
  const raw = jsonl(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
        ],
      },
    },
  );
  const items = adaptMessages(normalizeTranscriptLines(raw));
  assert.deepEqual(items, [
    {
      role: "tool",
      id: "tu_1",
      name: "Bash",
      input: { command: "ls" },
      result: "file.txt",
      isError: false,
      ts: null,
    },
  ]);
});

test("adaptMessages: error tool_result sets isError; unmatched result is dropped", () => {
  const raw = jsonl(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_2", name: "Write", input: { file_path: "/x" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_2", content: "denied", is_error: true },
          { type: "tool_result", tool_use_id: "tu_unknown", content: "orphan" },
        ],
      },
    },
  );
  const items = adaptMessages(normalizeTranscriptLines(raw));
  assert.equal(items.length, 1);
  const card = items[0] as Extract<(typeof items)[number], { role: "tool" }>;
  assert.equal(card.result, "denied");
  assert.equal(card.isError, true);
});

test("adaptMessages: injected meta user messages are skipped", () => {
  const raw = jsonl(
    {
      type: "user",
      message: { role: "user", content: "<command-name>/clear</command-name>" },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>noise</system-reminder>" }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: "real question" },
    },
  );
  const items = adaptMessages(normalizeTranscriptLines(raw));
  assert.deepEqual(items, [{ role: "user", text: "real question", ts: null }]);
});
