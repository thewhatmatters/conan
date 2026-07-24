import { strict as assert } from "node:assert";
import { test } from "node:test";
import { adaptRollout } from "./codexHistory.js";

// Records are shaped like Codex's real rollout JSONL
// ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl), captured
// from live runs of codex-cli 0.144.6.

const msg = (role: string, text: string) => ({
  type: "response_item",
  payload: { type: "message", role, content: [{ type: "input_text", text }] },
});

test("adaptRollout: user + assistant messages become chat items in order", () => {
  const items = adaptRollout([
    msg("user", "Remember the codeword: zephyr"),
    msg("assistant", "Got it — zephyr."),
    msg("user", "What was the codeword?"),
    msg("assistant", "zephyr"),
  ]);
  assert.deepEqual(items, [
    { role: "user", text: "Remember the codeword: zephyr" },
    { role: "assistant", text: "Got it — zephyr." },
    { role: "user", text: "What was the codeword?" },
    { role: "assistant", text: "zephyr" },
  ]);
});

test("adaptRollout: developer messages and injected user meta are dropped", () => {
  const items = adaptRollout([
    msg("developer", "<permissions instructions>\nsandbox_mode is read-only"),
    msg("user", "<recommended_plugins>\nHere is a list of plugins"),
    msg("user", "<environment_context>\n  <cwd>/tmp</cwd>"),
    msg("user", "# AGENTS.md instructions for /Users/x/proj\n<INSTRUCTIONS>"),
    msg("user", "Which model is this?"),
  ]);
  // Only the real prompt survives — the rest would render as fake bubbles.
  assert.deepEqual(items, [{ role: "user", text: "Which model is this?" }]);
});

test("adaptRollout: function_call merges its output by call_id", () => {
  const items = adaptRollout([
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_abc",
        arguments: '{"cmd":"echo hi"}',
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_abc", output: "hi\n" },
    },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    role: "tool",
    id: "call_abc",
    name: "exec_command",
    input: { cmd: "echo hi" },
    result: "hi\n",
    isError: false,
  });
});

test("adaptRollout: custom_tool_call keeps its raw string input", () => {
  const items = adaptRollout([
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call_p",
        input: "*** Begin Patch\n*** Add File: a.txt",
      },
    },
    {
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_p", output: "ok" },
    },
  ]);
  assert.equal(items.length, 1);
  const card = items[0] as Extract<(typeof items)[number], { role: "tool" }>;
  assert.equal(card.name, "apply_patch");
  assert.equal(card.input, "*** Begin Patch\n*** Add File: a.txt");
  assert.equal(card.result, "ok");
});

test("adaptRollout: encrypted reasoning and unknown records are ignored", () => {
  const items = adaptRollout([
    {
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: "gAAAA..." },
    } as never,
    { type: "world_state", payload: { full: true } } as never,
    { type: "event_msg", payload: { type: "task_started" } } as never,
    { type: "response_item", payload: { type: "some_future_type" } } as never,
    msg("assistant", "done"),
  ]);
  // Codex encrypts reasoning (empty summary), so a row would render blank;
  // unknown types must never break the reader.
  assert.deepEqual(items, [{ role: "assistant", text: "done" }]);
});

test("adaptRollout: an unmatched tool output is dropped, not orphaned", () => {
  const items = adaptRollout([
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "nope", output: "x" },
    },
    msg("assistant", "hi"),
  ]);
  assert.deepEqual(items, [{ role: "assistant", text: "hi" }]);
});
