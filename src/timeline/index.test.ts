// parseTouchedFiles() powers the File Explorer's "Claude touched this" badges:
// it reduces a session's Edit/Write/Read hook events to file-path sets, with
// edited (Edit/Write) outranking read (Read) for the same path. Pure, so it's
// unit-tested directly with synthetic event rows. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTouchedFiles, mapHookEventToRow, deriveAgentSpawns } from "./index.js";
import type { EventRow } from "../session/index.js";

/** A persisted-event row as the gateway query hands it to the parser. */
function row(tool: string, filePath?: string, raw?: string) {
  return {
    tool_name: tool,
    payload: raw ?? JSON.stringify({ tool_input: { file_path: filePath } }),
  };
}

/** A persisted hook event row, as mapHookEventToRow consumes it. */
function hookRow(overrides: Partial<EventRow> & { hook_event_name: string }): EventRow {
  return {
    id: 1,
    session_id: "s1",
    parent_tool_use_id: null,
    stream_type: "hook",
    tool_name: null,
    payload: null,
    ts: 1000,
    ...overrides,
  };
}

test("splits edited (Edit/Write) from read (Read) by file_path", () => {
  const { edited, read } = parseTouchedFiles([
    row("Edit", "/p/a.ts"),
    row("Write", "/p/b.ts"),
    row("Read", "/p/c.ts"),
  ]);
  assert.deepEqual(edited.sort(), ["/p/a.ts", "/p/b.ts"]);
  assert.deepEqual(read, ["/p/c.ts"]);
});

test("a path both read and edited counts only as edited", () => {
  const { edited, read } = parseTouchedFiles([
    row("Read", "/p/a.ts"),
    row("Edit", "/p/a.ts"),
  ]);
  assert.deepEqual(edited, ["/p/a.ts"]);
  assert.deepEqual(read, []);
});

test("dedups repeated touches of the same path", () => {
  const { edited } = parseTouchedFiles([
    row("Edit", "/p/a.ts"),
    row("Edit", "/p/a.ts"),
  ]);
  assert.deepEqual(edited, ["/p/a.ts"]);
});

test("skips rows with malformed payloads or no file_path", () => {
  const { edited, read } = parseTouchedFiles([
    row("Edit", undefined, "not json{"),
    row("Read", undefined, JSON.stringify({ tool_input: {} })),
    { tool_name: "Edit", payload: null },
    row("Edit", "/p/ok.ts"),
  ]);
  assert.deepEqual(edited, ["/p/ok.ts"]);
  assert.deepEqual(read, []);
});

test("SubagentStop maps to a SUBAGENT row, not the generic EVENT default", () => {
  const result = mapHookEventToRow(
    hookRow({
      hook_event_name: "SubagentStop",
      payload: JSON.stringify({
        agent_id: "a1",
        agent_type: "",
        agent_transcript_path: "/tmp/transcript.jsonl",
        last_assistant_message: "Audited the skill and found no issues.",
        stop_hook_active: false,
      }),
    }),
  );
  assert.ok(result);
  assert.equal(result?.kind, "hook");
  if (result?.kind === "hook") {
    assert.equal(result.subtype, "SUBAGENT");
    assert.equal(result.title, "Subagent finished");
    assert.equal(result.detail, "Audited the skill and found no issues.");
  }
});

test("SubagentStop with no last_assistant_message has no detail", () => {
  const result = mapHookEventToRow(
    hookRow({
      hook_event_name: "SubagentStop",
      payload: JSON.stringify({
        agent_id: "a1",
        agent_type: "",
        agent_transcript_path: "/tmp/transcript.jsonl",
        last_assistant_message: "",
        stop_hook_active: false,
      }),
    }),
  );
  assert.ok(result);
  if (result?.kind === "hook") {
    assert.equal(result.subtype, "SUBAGENT");
    assert.equal(result.detail, undefined);
  }
});

/** A PreToolUse/PostToolUse("Agent") event, as the gateway persists it. */
function agentEvent(overrides: Partial<EventRow> & { hook_event_name: string }): EventRow {
  return {
    id: 1,
    session_id: "s1",
    parent_tool_use_id: null,
    stream_type: "hook",
    tool_name: "Agent",
    payload: null,
    ts: 1000,
    ...overrides,
  };
}

test("a matched Agent Pre/Post pair closes with duration/tokens/toolCallCount populated", () => {
  const pre = agentEvent({
    id: 1,
    hook_event_name: "PreToolUse",
    ts: 1000,
    payload: JSON.stringify({
      tool_use_id: "toolu_1",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", description: "audit the skill" },
    }),
  });
  const post = agentEvent({
    id: 2,
    hook_event_name: "PostToolUse",
    ts: 5000,
    payload: JSON.stringify({
      tool_use_id: "toolu_1",
      tool_name: "Agent",
      tool_response: {
        agentType: "general-purpose",
        totalDurationMs: 4000,
        totalTokens: 12345,
        totalToolUseCount: 7,
      },
    }),
  });
  const bars = deriveAgentSpawns([pre, post]);
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0], {
    toolUseId: "toolu_1",
    startedAt: 1000,
    endedAt: 5000,
    agentType: "general-purpose",
    description: "audit the skill",
    durationMs: 4000,
    tokens: 12345,
    toolCallCount: 7,
  });
});

test("an unmatched Agent Pre with no Post yields a running (endedAt: null) bar", () => {
  const pre = agentEvent({
    id: 1,
    hook_event_name: "PreToolUse",
    ts: 1000,
    payload: JSON.stringify({
      tool_use_id: "toolu_2",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", description: "find the config" },
    }),
  });
  const bars = deriveAgentSpawns([pre]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]?.endedAt, null);
  assert.equal(bars[0]?.agentType, "Explore");
});

test("a Stop event closes any still-open Agent bars for that session", () => {
  const pre = agentEvent({
    id: 1,
    hook_event_name: "PreToolUse",
    ts: 1000,
    payload: JSON.stringify({
      tool_use_id: "toolu_3",
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", description: "still running" },
    }),
  });
  const stop = agentEvent({
    id: 2,
    hook_event_name: "Stop",
    tool_name: null,
    ts: 9000,
    payload: JSON.stringify({}),
  });
  const bars = deriveAgentSpawns([pre, stop]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]?.endedAt, 9000);
  // Orphan close-out never fabricates duration/token totals — those only
  // come from a real PostToolUse.
  assert.equal(bars[0]?.durationMs, undefined);
});
