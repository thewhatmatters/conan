// US-004 CodexDriver: the JSONL parser against the US-001 fixtures (no live
// codex calls — fixtures are the verified ground truth), the argv builder's
// pinned footguns (flags BEFORE the resume subcommand, prompt as argv), and
// the sandbox mapping. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_CAPABILITIES,
  CodexDriver,
  CodexStreamParser,
  buildCodexArgs,
  sandboxFor,
} from "./codex.js";
import type { AgentEvent } from "./driver.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Run every line of a fixture through a fresh parser. */
function parseFixture(name: string, sandbox = "read-only"): AgentEvent[] {
  const parser = new CodexStreamParser({ cwd: "/tmp/conan-probe", sandbox });
  const out: AgentEvent[] = [];
  for (const line of readFileSync(join(here, "fixtures", name), "utf8").split("\n")) {
    out.push(...parser.push(line));
  }
  return out;
}

test("codex parser: basic turn → system, whole assistant-text, result with tokens and null USD", () => {
  const evs = parseFixture("codex-turn1.jsonl");
  assert.deepEqual(
    evs.map((e) => e.kind),
    ["system", "assistant-text", "result"],
  );
  const [system, text, result] = evs as [
    Extract<AgentEvent, { kind: "system" }>,
    Extract<AgentEvent, { kind: "assistant-text" }>,
    Extract<AgentEvent, { kind: "result" }>,
  ];
  // thread.started carries the resume key as the session id.
  assert.equal(system.sessionId, "019f91f2-d60a-71b3-97ea-e6fc0327898c");
  assert.equal(system.permissionMode, "read-only");
  assert.equal(system.cwd, "/tmp/conan-probe");
  // Whole block, never a delta — codex has no token streaming.
  assert.equal(text.text, "probe-ok");
  assert.equal(text.delta, undefined);
  // Token usage rides the result; USD is null, never fabricated.
  assert.equal(result.isError, false);
  assert.equal(result.costUsd, null);
  assert.equal(result.text, "probe-ok");
  assert.deepEqual(result.tokens, {
    input: 17505,
    cachedInput: 13056,
    output: 6,
    reasoningOutput: 0,
  });
});

test("codex parser: tool turn → tool-use/tool-result for command_execution and file_change", () => {
  const evs = parseFixture("codex-turn3-tools.jsonl", "workspace-write");
  const uses = evs.filter((e) => e.kind === "tool-use");
  const results = evs.filter((e) => e.kind === "tool-result");
  assert.deepEqual(
    uses.map((u) => [u.id, u.name]),
    [
      ["item_1", "Command"],
      ["item_2", "FileChange"],
      ["item_3", "Command"],
    ],
  );
  assert.equal(
    (uses[0]!.input as { command: string }).command,
    "/bin/zsh -lc 'echo hello-probe'",
  );
  // Results correlate by id; a 0 exit code is not an error.
  assert.deepEqual(
    results.map((r) => [r.id, r.isError]),
    [
      ["item_1", false],
      ["item_2", false],
      ["item_3", false],
    ],
  );
  assert.equal(results[0]!.content, "hello-probe\n");
  assert.equal(results[1]!.content, "add /tmp/conan-probe/probe.txt");
  // Both agent messages surface; the LAST becomes the result text.
  const texts = evs.filter((e) => e.kind === "assistant-text").map((e) => e.text);
  assert.equal(texts.length, 2);
  const result = evs.find((e) => e.kind === "result")!;
  assert.equal(result.text, "done");
});

test("codex parser: nonzero exit codes and completed-without-started items are handled", () => {
  const parser = new CodexStreamParser({ cwd: null, sandbox: "read-only" });
  // No item.started observed — the completed item still opens its card.
  const evs = parser.push(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_9",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    }),
  );
  assert.deepEqual(evs.map((e) => e.kind), ["tool-use", "tool-result"]);
  assert.equal((evs[1] as Extract<AgentEvent, { kind: "tool-result" }>).isError, true);
});

test("codex parser: unknown event/item types and non-JSON noise are ignored, never thrown", () => {
  const parser = new CodexStreamParser({ cwd: null, sandbox: "read-only" });
  assert.deepEqual(parser.push("not json at all"), []);
  assert.deepEqual(parser.push(JSON.stringify({ type: "session.migrated", data: 1 })), []);
  assert.deepEqual(parser.push(JSON.stringify({ type: "turn.started" })), []);
  assert.deepEqual(
    parser.push(
      JSON.stringify({ type: "item.completed", item: { id: "i", type: "reasoning_v2" } }),
    ),
    [],
  );
});

test("codex parser: turn.failed closes the turn as an error result", () => {
  const parser = new CodexStreamParser({ cwd: null, sandbox: "read-only" });
  const evs = parser.push(
    JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }),
  );
  assert.deepEqual(evs.map((e) => e.kind), ["result"]);
  const result = evs[0] as Extract<AgentEvent, { kind: "result" }>;
  assert.equal(result.isError, true);
  assert.equal(result.text, "rate limited");
});

test("codex args: global flags BEFORE the resume subcommand, prompt as the last argv", () => {
  // Fresh turn — no resume subcommand.
  assert.deepEqual(
    buildCodexArgs({
      cwd: "/w",
      sandbox: "read-only",
      threadId: null,
      prompt: "hello",
    }),
    ["exec", "--json", "--skip-git-repo-check", "-C", "/w", "--sandbox", "read-only", "hello"],
  );
  // Resume turn — the verified flag-order footgun: -C after `resume` exits 2.
  assert.deepEqual(
    buildCodexArgs({
      cwd: "/w",
      sandbox: "workspace-write",
      threadId: "tid-1",
      model: "gpt-5",
      prompt: "again",
    }),
    [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/w",
      "--sandbox",
      "workspace-write",
      "-m",
      "gpt-5",
      "resume",
      "tid-1",
      "again",
    ],
  );
});

test("codex sandbox mapping: both vocabularies land on the right policy, unknown → read-only", () => {
  assert.equal(sandboxFor("read-only"), "read-only");
  assert.equal(sandboxFor("workspace-write"), "workspace-write");
  assert.equal(sandboxFor("danger-full-access"), "danger-full-access");
  // Claude-vocab frames (today's WS handler) map onto the nearest sandbox.
  assert.equal(sandboxFor("default"), "read-only");
  assert.equal(sandboxFor("plan"), "read-only");
  assert.equal(sandboxFor("acceptEdits"), "workspace-write");
  assert.equal(sandboxFor("bypassPermissions"), "danger-full-access");
  // The safe floor, never a silent full-access default.
  assert.equal(sandboxFor(undefined), "read-only");
  assert.equal(sandboxFor("whatever"), "read-only");
});

test("codex driver: declares the verified capabilities; respondPermission is a no-op; mode switch applies next turn", () => {
  const events: AgentEvent[] = [];
  const driver = new CodexDriver((e) => events.push(e), () => null);
  assert.equal(driver.provider, "codex");
  assert.equal(driver.capabilities, CODEX_CAPABILITIES);
  // No approval channel — answering a (nonexistent) request does nothing.
  driver.respondPermission("id", "accept");
  assert.deepEqual(events, []);
  // A mode switch is stored for the next spawn and confirmed honestly.
  driver.setPermissionMode("bypassPermissions");
  assert.deepEqual(events, [{ kind: "permission-mode", mode: "bypassPermissions" }]);
  driver.dispose();
});
