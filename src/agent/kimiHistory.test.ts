import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptKimiHistory, findKimiWireFile, readKimiHistory } from "./kimiHistory.js";

// Records are shaped like Kimi's real wire log
// (~/.kimi-code/sessions/wd_<basename>_<hash>/<session_id>/agents/main/
// wire.jsonl), captured from live runs of kimi 0.27.0 driven by Conan.

const userMsg = (text: string, kind = "user") => ({
  type: "context.append_message",
  time: 1785865047055,
  message: {
    role: "user",
    content: [{ type: "text", text }],
    toolCalls: [],
    origin: { kind },
  },
});

const loop = (event: Record<string, unknown>, time = 1785865087440) => ({
  type: "context.append_loop_event",
  time,
  event,
});

test("adaptKimiHistory: a prompt and its reply become user + assistant rows", () => {
  const items = adaptKimiHistory([
    { type: "metadata", protocol_version: "1.4", created_at: 1785865087005 } as never,
    { type: "turn.prompt", input: [{ type: "text", text: "Testing a new chat" }] } as never,
    userMsg("Testing a new chat"),
    loop({ type: "step.begin", uuid: "s1", turnId: "0", step: 1 }),
    loop({ type: "content.part", part: { type: "text", text: "Test received." } }),
    loop({ type: "step.end", uuid: "s1", turnId: "0", step: 1 }),
  ]);
  assert.deepEqual(items, [
    { role: "user", text: "Testing a new chat", ts: 1785865047055 },
    { role: "assistant", text: "Test received.", ts: 1785865087440 },
  ]);
});

test("adaptKimiHistory: turn.prompt does not double the user's message", () => {
  // Kimi writes the prompt TWICE — once as turn.prompt, once as the context
  // message. Reading both would render every prompt as two bubbles.
  const items = adaptKimiHistory([
    { type: "turn.prompt", input: [{ type: "text", text: "only once" }], time: 1 } as never,
    userMsg("only once"),
  ]);
  assert.deepEqual(items, [{ role: "user", text: "only once", ts: 1785865047055 }]);
});

test("adaptKimiHistory: injected and skill-activation messages are dropped", () => {
  // Kimi's own text rides the user role; only origin.kind 'user' is the person.
  const items = adaptKimiHistory([
    userMsg("<system-reminder>\nAuto permission mode is active.", "injection"),
    userMsg('Skill "check-kimi-code-docs" loaded inline.', "skill_activation"),
    userMsg("the real question"),
  ]);
  assert.deepEqual(items, [
    { role: "user", text: "the real question", ts: 1785865047055 },
  ]);
});

test("adaptKimiHistory: think parts become reasoning rows", () => {
  // The live stream-json output carries no reasoning at all, but the wire log
  // does — and it is readable, not encrypted like Codex's.
  const items = adaptKimiHistory([
    loop({ type: "content.part", part: { type: "think", think: "The user says…" } }),
    loop({ type: "content.part", part: { type: "text", text: "There are three causes." } }),
  ]);
  assert.deepEqual(items, [
    { role: "reasoning", text: "The user says…", ts: 1785865087440 },
    { role: "assistant", text: "There are three causes.", ts: 1785865087440 },
  ]);
});

test("adaptKimiHistory: a tool call merges with its result by toolCallId", () => {
  const items = adaptKimiHistory([
    loop({
      type: "tool.call",
      uuid: "tool_A",
      toolCallId: "tool_A",
      name: "FetchURL",
      args: { url: "https://example.com" },
    }),
    loop({
      type: "tool.result",
      parentUuid: "tool_A",
      toolCallId: "tool_A",
      result: { output: "page text" },
    }),
  ]);
  assert.deepEqual(items, [
    {
      role: "tool",
      id: "tool_A",
      name: "FetchURL",
      input: { url: "https://example.com" },
      result: "page text",
      isError: false,
      ts: 1785865087440,
    },
  ]);
});

test("adaptKimiHistory: a failed tool result sets isError", () => {
  const items = adaptKimiHistory([
    loop({ type: "tool.call", toolCallId: "tool_B", name: "Edit", args: {} }),
    loop({
      type: "tool.result",
      toolCallId: "tool_B",
      result: { output: "old_string not found in src/App.tsx", isError: true },
    }),
  ]);
  const card = items[0] as Extract<(typeof items)[number], { role: "tool" }>;
  assert.equal(card.isError, true);
  assert.equal(card.result, "old_string not found in src/App.tsx");
});

test("adaptKimiHistory: two calls in one step each keep their own result", () => {
  // A step can emit several tool.call records before any result arrives —
  // correlation is by id, never by order.
  const items = adaptKimiHistory([
    loop({ type: "tool.call", toolCallId: "a", name: "FetchURL", args: { url: "u1" } }),
    loop({ type: "tool.call", toolCallId: "b", name: "FetchURL", args: { url: "u2" } }),
    loop({ type: "tool.result", toolCallId: "b", result: { output: "second" } }),
    loop({ type: "tool.result", toolCallId: "a", result: { output: "first" } }),
  ]);
  assert.deepEqual(
    items.map((i) => (i.role === "tool" ? [i.id, i.result] : i.role)),
    [
      ["a", "first"],
      ["b", "second"],
    ],
  );
});

test("adaptKimiHistory: an unmatched tool result is dropped, never orphaned", () => {
  const items = adaptKimiHistory([
    loop({ type: "tool.result", toolCallId: "gone", result: { output: "x" } }),
  ]);
  assert.deepEqual(items, []);
});

test("adaptKimiHistory: unknown record types are ignored, not thrown", () => {
  const items = adaptKimiHistory([
    { type: "llm.request", messageCount: 3 } as never,
    { type: "usage.record", usage: { output: 376 } } as never,
    { type: "some.future.record" },
    userMsg("still read"),
  ]);
  assert.deepEqual(items, [{ role: "user", text: "still read", ts: 1785865047055 }]);
});

/* ---------------------------------------------------------------------------
 * Store resolution — the wd_ shard is a hash we can't recompute, so the
 * session index is the lookup table.
 * ------------------------------------------------------------------------ */

/** Build a throwaway ~/.kimi-code tree and point KIMI_CODE_HOME at it. */
function fixtureHome(t: { after: (fn: () => void) => void }): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-home-"));
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function writeSession(home: string, shard: string, sessionId: string, lines: unknown[]): string {
  const dir = path.join(home, "sessions", shard, sessionId, "agents", "main");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wire.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path.join(home, "sessions", shard, sessionId);
}

test("findKimiWireFile: resolves the wd_ shard through session_index.jsonl", (t) => {
  const home = fixtureHome(t);
  const dir = writeSession(home, "wd_proj_deadbeef", "session_1", [userMsg("hi")]);
  fs.writeFileSync(
    path.join(home, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_1", sessionDir: dir, workDir: "/tmp/proj" }) + "\n",
  );
  assert.equal(findKimiWireFile("session_1"), path.join(dir, "agents", "main", "wire.jsonl"));
});

test("findKimiWireFile: falls back to a shard scan when the index is stale", (t) => {
  const home = fixtureHome(t);
  // The session exists on disk but the index has not been rewritten yet.
  const dir = writeSession(home, "wd_proj_deadbeef", "session_2", [userMsg("hi")]);
  fs.writeFileSync(
    path.join(home, "session_index.jsonl"),
    JSON.stringify({ sessionId: "someone_else", sessionDir: "/nope" }) + "\n",
  );
  assert.equal(findKimiWireFile("session_2"), path.join(dir, "agents", "main", "wire.jsonl"));
});

test("findKimiWireFile: rejects a session id that would escape the store", (t) => {
  fixtureHome(t);
  assert.equal(findKimiWireFile("../../etc/passwd"), null);
  assert.equal(findKimiWireFile("a/b"), null);
});

test("readKimiHistory: an unknown session degrades to found:false", (t) => {
  fixtureHome(t);
  assert.deepEqual(readKimiHistory("session_missing"), { found: false, items: [] });
});

test("readKimiHistory: reads a real session end to end", (t) => {
  const home = fixtureHome(t);
  const dir = writeSession(home, "wd_proj_deadbeef", "session_3", [
    { type: "metadata", protocol_version: "1.4" },
    userMsg("Why does the chat keep disappearing?"),
    userMsg("<system-reminder>ignored", "injection"),
    loop({ type: "content.part", part: { type: "text", text: "Let me check the docs." } }),
    loop({ type: "tool.call", toolCallId: "t1", name: "FetchURL", args: { url: "u" } }),
    loop({ type: "tool.result", toolCallId: "t1", result: { output: "docs" } }),
  ]);
  fs.writeFileSync(
    path.join(home, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_3", sessionDir: dir }) + "\n",
  );
  const history = readKimiHistory("session_3");
  assert.equal(history.found, true);
  assert.deepEqual(
    history.items.map((i) => i.role),
    ["user", "assistant", "tool"],
  );
});

test("readKimiHistory: a half-written trailing line is skipped, not fatal", (t) => {
  const home = fixtureHome(t);
  const dir = writeSession(home, "wd_proj_deadbeef", "session_4", [userMsg("kept")]);
  // A wire log is appended to while a turn streams — the tail can be partial.
  fs.appendFileSync(
    path.join(dir, "agents", "main", "wire.jsonl"),
    '{"type":"context.append_loop_ev',
  );
  fs.writeFileSync(
    path.join(home, "session_index.jsonl"),
    JSON.stringify({ sessionId: "session_4", sessionDir: dir }) + "\n",
  );
  const history = readKimiHistory("session_4");
  assert.equal(history.found, true);
  assert.deepEqual(history.items, [{ role: "user", text: "kept", ts: 1785865047055 }]);
});
