import { strict as assert } from "node:assert";
import { test } from "node:test";
import { adaptGrokHistory } from "./grokHistory.js";

// Records are shaped like Grok's real chat_history.jsonl
// ($GROK_HOME/sessions/<encodeURIComponent(cwd)>/<session_id>/), captured from
// live runs of grok 0.2.111.

const user = (text: string) => ({ type: "user", content: [{ type: "text", text }] });

test("adaptGrokHistory: the real prompt is unwrapped from <user_query>", () => {
  const items = adaptGrokHistory([
    user("<user_query>\nReply with the single word OK.\n</user_query>"),
    { type: "assistant", content: "OK" },
  ]);
  assert.deepEqual(items, [
    { role: "user", text: "Reply with the single word OK." },
    { role: "assistant", text: "OK" },
  ]);
});

test("adaptGrokHistory: system and injected user context are dropped", () => {
  const items = adaptGrokHistory([
    { type: "system", content: "You are Grok 4.5 released by xAI." },
    user("<user_info>\nOS Version: macos\nShell: /bin/zsh"),
    user("<system-reminder>\nbackground context</system-reminder>"),
    user("<user_query>\nreal question\n</user_query>"),
  ]);
  // Only the real prompt survives — the rest would render as fake bubbles.
  assert.deepEqual(items, [{ role: "user", text: "real question" }]);
});

test("adaptGrokHistory: reasoning summary text becomes a reasoning row", () => {
  // Unlike Claude (redacted) and Codex (encrypted), Grok's summary is readable
  // — this is what GROK_CAPABILITIES.reasoningText: true promises.
  const items = adaptGrokHistory([
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "The user is asking which model." }],
      encrypted_content: "irvyC...",
    } as never,
    { type: "assistant", content: "**Grok 4.5** (xAI)." },
  ]);
  assert.deepEqual(items, [
    { role: "reasoning", text: "The user is asking which model." },
    { role: "assistant", text: "**Grok 4.5** (xAI)." },
  ]);
});

test("adaptGrokHistory: assistant tool_calls merge with their tool_result", () => {
  const items = adaptGrokHistory([
    {
      type: "assistant",
      content: "Checking the branch.",
      tool_calls: [
        {
          id: "call-1",
          name: "run_terminal_command",
          arguments: '{"command":"git status -sb"}',
        },
      ],
    },
    { type: "tool_result", tool_call_id: "call-1", content: "exit: 0\nui-updates" },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { role: "assistant", text: "Checking the branch." });
  assert.deepEqual(items[1], {
    role: "tool",
    id: "call-1",
    name: "run_terminal_command",
    input: { command: "git status -sb" },
    result: "exit: 0\nui-updates",
    isError: false,
  });
});

test("adaptGrokHistory: multi-turn order is preserved across appended turns", () => {
  const items = adaptGrokHistory([
    user("<user_query>\nRemember: quasar\n</user_query>"),
    { type: "assistant", content: "Noted." },
    user("<user_query>\nWhat was it?\n</user_query>"),
    { type: "assistant", content: "quasar" },
  ]);
  assert.deepEqual(
    items.map((i) => i.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal((items[3] as { text: string }).text, "quasar");
});

test("adaptGrokHistory: unmatched tool_result and unknown types are ignored", () => {
  const items = adaptGrokHistory([
    { type: "tool_result", tool_call_id: "missing", content: "orphan" },
    { type: "some_future_type", content: "x" } as never,
    { type: "assistant", content: "hi" },
  ]);
  assert.deepEqual(items, [{ role: "assistant", text: "hi" }]);
});
