// US-007 test: normalize the stream-json event stream into the event store.
//
// Two layers:
//   1. Unit tests of parseStreamMessage() — pure, deterministic coverage of
//      every message type the criteria call out (system/init, system/api_retry,
//      stream_event content_block_start/delta/stop, assistant, result), the
//      text_delta / input_json_delta extraction, usage/cost capture, and
//      parent_tool_use_id preservation.
//   2. An integration test that spawns a fake `claude` emitting a full stream
//      and asserts the session manager persisted event rows and folded the
//      token/cost figures onto the session row.
//
// Run: tsx scripts/test-parser.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { parseStreamMessage } = await import(
  pathToFileURL(path.resolve("src/session/parser.ts")).href
);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

// --- 1. Unit tests --------------------------------------------------------

// blank / unparseable lines are skipped
check("blank line → null", parseStreamMessage("   ") === null);
check("garbage line → null", parseStreamMessage("not json") === null);

// system/init: session_id + model + the documented metadata fields
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-4-6",
      tools: ["Bash", "Read"],
      mcp_servers: [{ name: "figma", status: "connected" }],
      plugins: ["p1"],
      plugin_errors: [],
      slash_commands: ["/loop"],
    }),
  );
  check("system/init captures session_id", p?.sessionId === "sess-1");
  check("system/init captures model", p?.model === "claude-sonnet-4-6");
  check("system/init streamType", p?.event?.streamType === "system/init");
  check("system/init payload keeps tools", Array.isArray(p?.event?.payload?.tools));
  check("system/init payload keeps mcp_servers", Array.isArray(p?.event?.payload?.mcp_servers));
  check("system/init payload keeps plugins", Array.isArray(p?.event?.payload?.plugins));
  check("system/init payload keeps plugin_errors", Array.isArray(p?.event?.payload?.plugin_errors));
}

// system/api_retry: stored generically under system/<subtype>
{
  const p = parseStreamMessage(
    JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2 }),
  );
  check("system/api_retry streamType", p?.event?.streamType === "system/api_retry");
  check("system/api_retry has no sessionId", p?.sessionId === null);
}

// stream_event: content_block_start with a tool_use block → toolName captured
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", name: "Bash", id: "tu-1" },
      },
    }),
  );
  check("content_block_start streamType", p?.event?.streamType === "stream_event:content_block_start");
  check("content_block_start captures tool_name", p?.event?.toolName === "Bash");
}

// stream_event: content_block_delta with text_delta extracted
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    }),
  );
  check("content_block_delta streamType", p?.event?.streamType === "stream_event:content_block_delta");
  check("text_delta extracted", p?.event?.payload?.delta?.type === "text_delta");
  check("text_delta text preserved", p?.event?.payload?.delta?.text === "Hello");
}

// stream_event: content_block_delta with input_json_delta extracted
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"cmd":' },
      },
    }),
  );
  check("input_json_delta extracted", p?.event?.payload?.delta?.type === "input_json_delta");
  check("input_json_delta partial preserved", p?.event?.payload?.delta?.partial_json === '{"cmd":');
}

// stream_event: content_block_stop
{
  const p = parseStreamMessage(
    JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  );
  check("content_block_stop streamType", p?.event?.streamType === "stream_event:content_block_stop");
}

// control_request: can_use_tool permission prompt (US-012)
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
    }),
  );
  check("can_use_tool streamType", p?.event?.streamType === "control_request:can_use_tool");
  check("can_use_tool records tool_name", p?.event?.toolName === "Bash");
  check("can_use_tool payload carries request_id", p?.event?.payload?.request_id === "req-1");
  check("can_use_tool payload carries input", p?.event?.payload?.input?.command === "ls");
}

// control_cancel_request supersedes a prompt (US-012)
{
  const p = parseStreamMessage(
    JSON.stringify({ type: "control_cancel_request", request_id: "req-1" }),
  );
  check("control_cancel_request streamType", p?.event?.streamType === "control_cancel_request");
  check("control_cancel_request carries request_id", p?.event?.payload?.request_id === "req-1");
}

// stream_event: message_delta carries usage (context-window figures)
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      },
    }),
  );
  check("message_delta usage input", p?.usage?.inputTokens === 100);
  check("message_delta usage output", p?.usage?.outputTokens === 20);
  check("message_delta usage cache_read", p?.usage?.cacheReadInputTokens === 50);
  check("message_delta context = input+cache", p?.usage?.contextTokens === 150);
}

// assistant message with a tool_use block → toolName + parent_tool_use_id
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "parent-tu",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", id: "tu-9" }],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    }),
  );
  check("assistant streamType", p?.event?.streamType === "assistant");
  check("assistant captures tool_name", p?.event?.toolName === "Edit");
  check("parent_tool_use_id preserved", p?.event?.parentToolUseId === "parent-tu");
  check("assistant usage captured", p?.usage?.inputTokens === 5);
}

// result: usage + total_cost_usd captured onto the session row
{
  const p = parseStreamMessage(
    JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 200, output_tokens: 40, cache_creation_input_tokens: 10 },
    }),
  );
  check("result streamType", p?.event?.streamType === "result");
  check("result captures total_cost_usd", p?.usage?.totalCostUsd === 0.0123);
  check("result captures input_tokens", p?.usage?.inputTokens === 200);
  check("result context = input+cache_creation", p?.usage?.contextTokens === 210);
}

// --- 2. Integration test: manager persists events + folds usage -----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-parser-test-"));
const dataDir = path.join(tmp, "data");
const SID = "parse-int-" + Math.random().toString(36).slice(2, 8);

const stub = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
const lines = [
  { type: "system", subtype: "init", session_id: ${JSON.stringify(SID)}, model: "claude-sonnet-4-6", tools: [] },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Bash", id: "tu-1" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } } },
  { type: "assistant", parent_tool_use_id: "tu-1", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "tu-1" }] } },
  { type: "result", subtype: "success", total_cost_usd: 0.05, usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 100 } },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
setTimeout(() => process.exit(0), 200);
`,
);
fs.chmodSync(stub, 0o755);

process.env.CONAN_CLAUDE_BIN = stub;
process.env.CONAN_DATA_DIR = dataDir;

const { startSession } = await import(
  pathToFileURL(path.resolve("src/session/index.ts")).href
);
const { getDb, closeDb } = await import(
  pathToFileURL(path.resolve("src/db/index.ts")).href
);

try {
  const result = startSession({ cwd: tmp });
  const sessionId = await Promise.race([
    result.sessionId,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for init")), 8000)),
  ]);
  check("integration captures session_id", sessionId === SID);

  // Give stdout a beat to drain all lines + the exit handler to fire.
  await new Promise((r) => setTimeout(r, 600));

  const db = getDb();
  const events = db.prepare("SELECT * FROM event WHERE session_id = ? ORDER BY id").all(sessionId);
  const types = events.map((e) => e.stream_type);
  check("persists system/init event", types.includes("system/init"));
  check("persists content_block_start event", types.includes("stream_event:content_block_start"));
  check("persists content_block_delta event", types.includes("stream_event:content_block_delta"));
  check("persists assistant event", types.includes("assistant"));
  check("persists result event", types.includes("result"));

  const toolRow = events.find((e) => e.stream_type === "stream_event:content_block_start");
  check("event row records tool_name", toolRow?.tool_name === "Bash");
  const childRow = events.find((e) => e.stream_type === "assistant");
  check("event row preserves parent_tool_use_id", childRow?.parent_tool_use_id === "tu-1");

  const row = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId);
  check("session row records total_cost_usd", row?.total_cost_usd === 0.05);
  check("session row records input_tokens", row?.input_tokens === 300);
  check("session row records output_tokens", row?.output_tokens === 60);
  check("session row records cache_read_input_tokens", row?.cache_read_input_tokens === 100);
  check("session row records context_tokens (input+cache)", row?.context_tokens === 400);

  result.child.kill();
  closeDb();
} catch (err) {
  console.log("FAIL - threw:", err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
