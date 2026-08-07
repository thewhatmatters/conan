// ClaudeStreamParser turns claude's stream-json NDJSON into normalized
// AgentEvents. The tricky part under test is streaming dedup: with
// `--include-partial-messages` the CLI emits text/thinking as incremental
// stream_event deltas AND still emits the aggregate `assistant` frame after
// (one frame PER content block, all sharing the message id) — the parser must
// stream the deltas and suppress the already-streamed whole blocks, while the
// whole-block fallback still works when no partial events arrive. Line shapes
// below mirror a captured real session (claude 2.1.218). Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ClaudeStreamParser,
  buildClaudeUserMessage,
  claudePromptFor,
  claudeModeFor,
  classifyTool,
  permissionDetail,
  isInteractivePermission,
  type ControlRequest,
  type ControlResponse,
} from "./claude.js";

const j = (o: unknown): string => JSON.stringify(o);

const messageStart = (id: string) =>
  j({ type: "stream_event", event: { type: "message_start", message: { id, role: "assistant" } } });
const textDelta = (text: string) =>
  j({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const thinkingDelta = (thinking: string) =>
  j({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking, estimated_tokens: null } },
  });
const wholeAssistant = (id: string, content: unknown[]) =>
  j({ type: "assistant", message: { id, role: "assistant", content } });
const resultLine = () =>
  j({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, duration_ms: 1200, num_turns: 1, result: "done", usage: { input_tokens: 120, cache_read_input_tokens: 80, output_tokens: 7 } });

test("claude effort applies prompt-level phrasing and ignores unknown ids", () => {
  assert.equal(claudePromptFor("Do it", "think"), "Think carefully.\n\nDo it");
  assert.equal(
    claudePromptFor("Do it", "ultrathink"),
    "Ultrathink before answering.\n\nDo it",
  );
  assert.equal(claudePromptFor("Do it", "bogus"), "Do it");
});

test("claude image user message matches the verified fixture; text-only stays additive", () => {
  const expected = JSON.parse(
    readFileSync(
      new URL("./fixtures/claude-image-user-message.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
  const source = (
    expected as {
      message: {
        content: Array<{
          type: string;
          source?: { media_type: string; data: string };
        }>;
      };
    }
  ).message.content[0]?.source;
  assert.ok(source);
  assert.deepEqual(
    buildClaudeUserMessage(
      {
        text: "Reply with exactly: ok",
        attachments: [],
        images: [
          {
            type: "image",
            mediaType: source.media_type,
            data: source.data,
            bytes: Buffer.from(source.data, "base64").byteLength,
            stagedPath: "/tmp/conan-images/pixel.png",
          },
        ],
      },
      undefined,
    ),
    expected,
  );
  assert.deepEqual(
    buildClaudeUserMessage({ text: "plain", attachments: [] }, undefined),
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "plain" }],
      },
    },
  );
});

test("text deltas stream incrementally and the whole frame is suppressed", () => {
  const p = new ClaudeStreamParser();
  assert.deepEqual(p.push(messageStart("msg_1")), []);
  assert.deepEqual(p.push(textDelta("Hello, ")), [
    { kind: "assistant-text", text: "Hello, ", delta: true },
  ]);
  assert.deepEqual(p.push(textDelta("world.")), [
    { kind: "assistant-text", text: "world.", delta: true },
  ]);
  // The aggregate frame for the same message must NOT re-emit the text.
  assert.deepEqual(
    p.push(wholeAssistant("msg_1", [{ type: "text", text: "Hello, world." }])),
    [],
  );
});

test("thinking deltas emit as reasoning and the whole thinking frame is suppressed", () => {
  const p = new ClaudeStreamParser();
  p.push(messageStart("msg_1"));
  assert.deepEqual(p.push(thinkingDelta("Let me count")), [
    { kind: "reasoning", text: "Let me count", delta: true },
  ]);
  // Real sessions emit the whole `thinking` block frame BEFORE the text
  // block frame, both under the same message id.
  assert.deepEqual(
    p.push(wholeAssistant("msg_1", [{ type: "thinking", thinking: "Let me count", signature: "sig" }])),
    [],
  );
  assert.deepEqual(p.push(textDelta("Five.")), [
    { kind: "assistant-text", text: "Five.", delta: true },
  ]);
  assert.deepEqual(
    p.push(wholeAssistant("msg_1", [{ type: "text", text: "Five." }])),
    [],
  );
});

test("MIXED: text streams as deltas but thinking arrives whole-frame only — reasoning must still emit (D2 regression)", () => {
  // The real bug: the model streams its TEXT as text_deltas (so message_start
  // fires and the id is 'seen'), but emits its THINKING only as a whole-frame
  // block with zero thinking_deltas. Suppressing on message_start alone dropped
  // the reasoning entirely. Per-modality suppression must let thinking through.
  const p = new ClaudeStreamParser();
  p.push(messageStart("msg_1"));
  assert.deepEqual(p.push(textDelta("Yes.")), [
    { kind: "assistant-text", text: "Yes.", delta: true },
  ]);
  // Whole-frame thinking (no thinking_delta ever streamed) → MUST emit.
  assert.deepEqual(
    p.push(wholeAssistant("msg_1", [{ type: "thinking", thinking: "17 is only divisible by 1 and 17." }])),
    [{ kind: "reasoning", text: "17 is only divisible by 1 and 17." }],
  );
  // Whole-frame text (already streamed as a delta) → still suppressed.
  assert.deepEqual(
    p.push(wholeAssistant("msg_1", [{ type: "text", text: "Yes." }])),
    [],
  );
});

test("whole-message fallback still emits text + reasoning when nothing streamed", () => {
  const p = new ClaudeStreamParser();
  assert.deepEqual(
    p.push(wholeAssistant("msg_9", [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Answer." },
    ])),
    [
      { kind: "reasoning", text: "hmm" },
      { kind: "assistant-text", text: "Answer." },
    ],
  );
});

test("tool_use always passes through, even on a streamed message", () => {
  const p = new ClaudeStreamParser();
  p.push(messageStart("msg_1"));
  p.push(textDelta("Running it."));
  const events = p.push(
    wholeAssistant("msg_1", [
      { type: "text", text: "Running it." },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ]),
  );
  assert.deepEqual(events, [
    { kind: "tool-use", id: "tu_1", name: "Bash", input: { command: "ls" } },
  ]);
});

test("signature/input_json deltas and block/message lifecycle events are ignored", () => {
  const p = new ClaudeStreamParser();
  p.push(messageStart("msg_1"));
  for (const line of [
    j({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }),
    j({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } } }),
    j({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"co' } } }),
    j({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    j({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } }),
    j({ type: "stream_event", event: { type: "message_stop" } }),
  ]) {
    assert.deepEqual(p.push(line), []);
  }
});

test("result clears streamed state; a later un-streamed message falls back whole", () => {
  const p = new ClaudeStreamParser();
  p.push(messageStart("msg_1"));
  p.push(textDelta("First turn."));
  const events = p.push(resultLine());
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "result");
  const result = events[0] as Extract<import("./driver.js").AgentEvent, { kind: "result" }>;
  assert.equal(result.contextTokens, 200);
  assert.deepEqual(result.tokens, {
    input: 120,
    cachedInput: 80,
    output: 7,
    reasoningOutput: null,
  });
  // Next turn without partial events (e.g. flag unsupported mid-flight) —
  // its whole frame must emit normally.
  assert.deepEqual(
    p.push(wholeAssistant("msg_2", [{ type: "text", text: "Second turn." }])),
    [{ kind: "assistant-text", text: "Second turn." }],
  );
});

test("non-JSON noise, blank lines, and unknown types produce nothing", () => {
  const p = new ClaudeStreamParser();
  assert.deepEqual(p.push(""), []);
  assert.deepEqual(p.push("not json"), []);
  assert.deepEqual(p.push(j({ type: "system", subtype: "hook_started" })), []);
  assert.deepEqual(p.push(j({ type: "rate_limit_event" })), []);
});

// control_response is Claude-internal plumbing (the answer to a stdin
// control_request like an interrupt): it must never leak into the AgentEvent
// stream, only into the driver's callback. Success shape captured live from
// claude 2.1.218.
test("system init carries the live permissionMode (re-emitted after a mode switch)", () => {
  const p = new ClaudeStreamParser();
  const init = j({
    type: "system",
    subtype: "init",
    session_id: "sess-1",
    model: "claude-fable-5",
    cwd: "/tmp/p",
    tools: ["Bash", "Write"],
    permissionMode: "plan",
  });
  assert.deepEqual(p.push(init), [
    {
      kind: "system",
      sessionId: "sess-1",
      model: "claude-fable-5",
      cwd: "/tmp/p",
      tools: ["Bash", "Write"],
      permissionMode: "plan",
    },
  ]);
});

test("control_response routes to the callback, not the event stream", () => {
  const got: ControlResponse[] = [];
  const p = new ClaudeStreamParser((r) => got.push(r));
  assert.deepEqual(
    p.push(
      j({
        type: "control_response",
        response: { subtype: "success", request_id: "intr-1", response: { still_queued: [] } },
      }),
    ),
    [],
  );
  assert.deepEqual(got, [{ requestId: "intr-1", ok: true, error: null }]);
});

test("control_response error surfaces ok:false with the message", () => {
  const got: ControlResponse[] = [];
  const p = new ClaudeStreamParser((r) => got.push(r));
  p.push(
    j({
      type: "control_response",
      response: { subtype: "error", request_id: "intr-2", error: "not supported" },
    }),
  );
  assert.deepEqual(got, [{ requestId: "intr-2", ok: false, error: "not supported" }]);
});

test("control_response without a callback (and malformed) is ignored safely", () => {
  const p = new ClaudeStreamParser();
  assert.deepEqual(
    p.push(j({ type: "control_response", response: { subtype: "success", request_id: "x" } })),
    [],
  );
  assert.deepEqual(p.push(j({ type: "control_response" })), []);
});

// can_use_tool control_requests (--permission-prompt-tool stdio) are the
// Supervised-mode permission prompts. Like control_response they are
// Claude-internal plumbing: routed to a driver callback, never into the
// AgentEvent stream. Shape captured live from claude 2.1.218.
test("can_use_tool control_request routes to the callback, not the event stream", () => {
  const got: ControlRequest[] = [];
  const p = new ClaudeStreamParser(undefined, (r) => got.push(r));
  assert.deepEqual(
    p.push(
      j({
        type: "control_request",
        request_id: "b430414f",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          display_name: "Bash",
          input: { command: "rm -f /tmp/x.txt", description: "Remove temp file" },
          description: "Remove temp file",
          permission_suggestions: [{ type: "addRules", rules: [] }],
          tool_use_id: "toolu_015D",
        },
      }),
    ),
    [],
  );
  assert.deepEqual(got, [
    {
      requestId: "b430414f",
      subtype: "can_use_tool",
      toolName: "Bash",
      input: { command: "rm -f /tmp/x.txt", description: "Remove temp file" },
      toolUseId: "toolu_015D",
      description: "Remove temp file",
    },
  ]);
});

test("can_use_tool preserves the interactive flag for AskUserQuestion", () => {
  const requests: ControlRequest[] = [];
  const p = new ClaudeStreamParser(undefined, (request) => requests.push(request));
  p.push(j({
    type: "control_request",
    request_id: "ask-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [] },
      requires_user_interaction: true,
      tool_use_id: "tool-ask",
    },
  }));
  assert.equal(requests[0]?.requiresUserInteraction, true);
});

test("AskUserQuestion is never session-approval eligible, even without the wire flag", () => {
  assert.equal(isInteractivePermission("AskUserQuestion"), true);
  assert.equal(isInteractivePermission("Bash"), false);
  assert.equal(isInteractivePermission("future-interactive-tool", true), true);
});

test("control_request without a callback (and malformed) is ignored safely", () => {
  const p = new ClaudeStreamParser();
  assert.deepEqual(
    p.push(j({ type: "control_request", request_id: "x", request: { subtype: "can_use_tool" } })),
    [],
  );
  assert.deepEqual(p.push(j({ type: "control_request" })), []);
});

test("ExitPlanMode approval detail is the proposed plan markdown", () => {
  const plan = "# Ship it\n\n- Add the UI\n- Verify the flow";
  assert.equal(permissionDetail("ExitPlanMode", { plan }), plan);
  assert.equal(permissionDetail("Bash", { command: "npm test" }), "npm test");
});

test("classifyTool groups tools into the approval kinds", () => {
  assert.equal(classifyTool("Bash"), "command");
  assert.equal(classifyTool("Read"), "file-read");
  assert.equal(classifyTool("Glob"), "file-read");
  assert.equal(classifyTool("Edit"), "file-change");
  assert.equal(classifyTool("Write"), "file-change");
  assert.equal(classifyTool("NotebookEdit"), "file-change");
  assert.equal(classifyTool("WebFetch"), "other");
  assert.equal(classifyTool("mcp__figma__get_screenshot"), "other");
});

test("claudeModeFor floors unknown mode ids to default (US-009)", () => {
  // Claude's own vocabulary passes through verbatim…
  assert.equal(claudeModeFor("default"), "default");
  assert.equal(claudeModeFor("plan"), "plan");
  assert.equal(claudeModeFor("acceptEdits"), "acceptEdits");
  assert.equal(claudeModeFor("bypassPermissions"), "bypassPermissions");
  // …while another provider's ids (a stale pick after a provider switch)
  // floor to Supervised instead of crashing the CLI.
  assert.equal(claudeModeFor("read-only"), "default");
  assert.equal(claudeModeFor("danger-full-access"), "default");
  assert.equal(claudeModeFor(undefined), "default");
});
