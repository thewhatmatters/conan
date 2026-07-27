import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkTranscript, WORKLOG_MIN_RUN } from "./worklog.ts";
import type { ChatItem } from "../hooks/useAgentChat.ts";

const user = (id: string): ChatItem => ({ id, role: "user", text: "hi" });
const asst = (id: string): ChatItem => ({ id, role: "assistant", text: "ok" });
const tool = (id: string): ChatItem => ({
  id,
  role: "tool",
  name: "Read",
  input: {},
  result: "ok",
  isError: false,
});

test("a run of >= WORKLOG_MIN_RUN tools folds into one group", () => {
  const items = [user("u1"), tool("t1"), tool("t2"), tool("t3")];
  const chunks = chunkTranscript(items);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], { kind: "single", item: items[0] });
  assert.equal(chunks[1]?.kind, "group");
  if (chunks[1]?.kind === "group") {
    assert.equal(chunks[1].id, "t1"); // first tool's id anchors the group
    assert.equal(chunks[1].tools.length, 3);
  }
});

test("a run shorter than the threshold stays inline as singles", () => {
  const items = [tool("t1"), tool("t2")]; // 2 < 3
  const chunks = chunkTranscript(items);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.kind === "single"));
});

test("narration breaks a run into separate groups", () => {
  const items = [
    tool("a1"),
    tool("a2"),
    tool("a3"),
    asst("say"),
    tool("b1"),
    tool("b2"),
    tool("b3"),
  ];
  const chunks = chunkTranscript(items);
  // group A, the assistant single, group B
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.kind, "group");
  assert.deepEqual(chunks[1], { kind: "single", item: items[3] });
  assert.equal(chunks[2]?.kind, "group");
  if (chunks[0]?.kind === "group" && chunks[2]?.kind === "group") {
    assert.equal(chunks[0].id, "a1");
    assert.equal(chunks[2].id, "b1");
  }
});

test("a non-tool between tools prevents a group when neither side reaches the threshold", () => {
  const items = [tool("t1"), tool("t2"), user("u"), tool("t3"), tool("t4")];
  const chunks = chunkTranscript(items);
  // 2 singles, 1 user single, 2 singles = 5, no group
  assert.equal(chunks.length, 5);
  assert.ok(chunks.every((c) => c.kind === "single"));
});

test("empty transcript yields no chunks", () => {
  assert.deepEqual(chunkTranscript([]), []);
});

test("WORKLOG_MIN_RUN is the documented threshold", () => {
  assert.equal(WORKLOG_MIN_RUN, 3);
  const justUnder = Array.from({ length: WORKLOG_MIN_RUN - 1 }, (_, i) =>
    tool(`x${i}`),
  );
  assert.ok(chunkTranscript(justUnder).every((c) => c.kind === "single"));
  const justAt = Array.from({ length: WORKLOG_MIN_RUN }, (_, i) => tool(`y${i}`));
  const chunks = chunkTranscript(justAt);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.kind, "group");
});
