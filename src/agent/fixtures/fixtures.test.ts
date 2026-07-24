// US-001 fixture sanity: the captured codex/grok NDJSON streams under
// src/agent/fixtures/ are the verified ground truth the CodexDriver and
// GrokDriver parsers are built against. These tests pin the invariants the
// capability matrix (README.md here) claims — if a re-capture with a newer CLI
// changes the shapes, these fail loudly instead of the drivers drifting from
// their fixtures. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const lines = (name: string): Record<string, unknown>[] =>
  readFileSync(join(here, name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("every fixture line is valid JSON with a type field", () => {
  for (const name of [
    "codex-turn1.jsonl",
    "codex-turn2-resume.jsonl",
    "codex-turn3-tools.jsonl",
    "grok-turn1.jsonl",
    "grok-turn2-resume.jsonl",
    "grok-approval-default.jsonl",
    "grok-turn4-filewrite.jsonl",
  ]) {
    for (const ev of lines(name)) {
      assert.equal(typeof ev.type, "string", `${name}: event missing type`);
    }
  }
});

test("codex: thread.started carries the resume key, turn.completed has token usage but no USD", () => {
  const evs = lines("codex-turn1.jsonl");
  const started = evs.find((e) => e.type === "thread.started") as { thread_id?: string };
  assert.ok(started?.thread_id, "thread.started must carry thread_id");
  const done = evs.find((e) => e.type === "turn.completed") as { usage?: Record<string, number> };
  assert.equal(typeof done?.usage?.input_tokens, "number");
  assert.equal(typeof done?.usage?.output_tokens, "number");
  assert.ok(!("total_cost_usd" in (done?.usage ?? {})), "codex reports tokens only, never USD");
  // No streaming deltas: text arrives only as whole item.completed agent_message items.
  assert.ok(evs.every((e) => e.type !== "text" && e.type !== "thought"));
});

test("codex: resume reuses the same thread_id and retains context", () => {
  const t1 = lines("codex-turn1.jsonl").find((e) => e.type === "thread.started") as { thread_id?: string };
  const t2evs = lines("codex-turn2-resume.jsonl");
  const t2 = t2evs.find((e) => e.type === "thread.started") as { thread_id?: string };
  assert.equal(t2?.thread_id, t1?.thread_id);
  const msg = t2evs.find(
    (e) => e.type === "item.completed" && (e.item as { type?: string })?.type === "agent_message",
  ) as { item?: { text?: string } };
  assert.equal(msg?.item?.text, "probe-ok", "turn 2 must answer from turn-1 context");
});

test("codex: tool turns emit command_execution and file_change items with status transitions", () => {
  const evs = lines("codex-turn3-tools.jsonl");
  const itemTypes = new Set(
    evs
      .filter((e) => e.type === "item.started" || e.type === "item.completed")
      .map((e) => (e.item as { type?: string })?.type),
  );
  assert.ok(itemTypes.has("command_execution"));
  assert.ok(itemTypes.has("file_change"));
  const cmdDone = evs.find(
    (e) => e.type === "item.completed" && (e.item as { type?: string })?.type === "command_execution",
  ) as { item?: { exit_code?: number; status?: string; aggregated_output?: string } };
  assert.equal(cmdDone?.item?.status, "completed");
  assert.equal(typeof cmdDone?.item?.exit_code, "number");
});

test("grok: stream is ONLY thought/text/end — real reasoning text, cost in USD on end", () => {
  const evs = lines("grok-turn1.jsonl");
  assert.deepEqual([...new Set(evs.map((e) => e.type))].sort(), ["end", "text", "thought"]);
  const thought = evs.find((e) => e.type === "thought") as { data?: string };
  assert.ok(thought?.data && thought.data.length > 0, "grok thought deltas carry REAL text (unlike headless claude, D2)");
  const end = evs.find((e) => e.type === "end") as {
    sessionId?: string;
    total_cost_usd?: number;
    num_turns?: number;
    usage?: Record<string, number>;
  };
  assert.ok(end?.sessionId, "end carries sessionId (the resume key)");
  assert.equal(typeof end?.total_cost_usd, "number");
  assert.equal(typeof end?.num_turns, "number");
  assert.equal(typeof end?.usage?.input_tokens, "number");
});

test("grok: resume reuses the same sessionId and retains context", () => {
  const end1 = lines("grok-turn1.jsonl").find((e) => e.type === "end") as { sessionId?: string };
  const t2 = lines("grok-turn2-resume.jsonl");
  const end2 = t2.find((e) => e.type === "end") as { sessionId?: string };
  assert.equal(end2?.sessionId, end1?.sessionId);
  const answer = t2
    .filter((e) => e.type === "text")
    .map((e) => (e as { data?: string }).data ?? "")
    .join("");
  assert.equal(answer, "probe-ok", "turn 2 must answer from turn-1 context");
});

test("grok: default permission mode headless CANCELS a tool-needing turn (no approval channel)", () => {
  const evs = lines("grok-approval-default.jsonl");
  const end = evs.find((e) => e.type === "end") as { stopReason?: string };
  assert.equal(end?.stopReason, "Cancelled", "open question (a): no interactive approval headlessly — the turn cancels");
  // And crucially: no permission-request event of any kind was emitted.
  assert.deepEqual([...new Set(evs.map((e) => e.type))].sort(), ["end", "thought"]);
});

test("grok: per-turn permission switch on resume works; tools stay invisible in the stream", () => {
  // Open question (b): the Cancelled session resumed with bypassPermissions ran
  // the tool to completion — and the stream STILL contains zero tool events.
  const evs = lines("grok-turn4-filewrite.jsonl");
  const end = evs.find((e) => e.type === "end") as { stopReason?: string };
  assert.equal(end?.stopReason, "EndTurn");
  assert.deepEqual([...new Set(evs.map((e) => e.type))].sort(), ["end", "text", "thought"]);
});
