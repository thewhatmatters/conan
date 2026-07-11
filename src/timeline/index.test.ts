// parseTouchedFiles() powers the File Explorer's "Claude touched this" badges:
// it reduces a session's Edit/Write/Read hook events to file-path sets, with
// edited (Edit/Write) outranking read (Read) for the same path. Pure, so it's
// unit-tested directly with synthetic event rows. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTouchedFiles, mapHookEventToRow } from "./index.js";
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
