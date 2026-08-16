// US-005 GrokDriver: the streaming-json parser against the US-001 fixtures
// (no live grok calls — fixtures are the verified ground truth), the argv
// builder, and the permission-mode mapping. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROK_CAPABILITIES,
  GrokDriver,
  GrokStreamParser,
  buildGrokArgs,
  buildGrokPromptBlocks,
  grokModeFor,
} from "./grok.js";
import type { AgentEvent } from "./driver.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Run every line of a fixture through a fresh parser. */
function parseFixture(name: string, mode = "default"): AgentEvent[] {
  const parser = new GrokStreamParser({ cwd: "/tmp/conan-probe", mode });
  const out: AgentEvent[] = [];
  for (const line of readFileSync(join(here, "fixtures", name), "utf8").split("\n")) {
    out.push(...parser.push(line));
  }
  return out;
}

test("grok parser: basic turn → reasoning + text deltas, then system + result from end", () => {
  const evs = parseFixture("grok-turn1.jsonl");
  // Every thought is a reasoning delta with REAL readable text (not D2-redacted).
  const reasoning = evs.filter((e) => e.kind === "reasoning");
  assert.equal(reasoning.length, 23);
  assert.ok(reasoning.every((r) => r.delta === true));
  assert.equal(reasoning[0]!.text, "The");
  // Text arrives as deltas that accumulate to the reply.
  const text = evs.filter((e) => e.kind === "assistant-text");
  assert.deepEqual(
    text.map((t) => [t.text, t.delta]),
    [
      ["probe", true],
      ["-", true],
      ["ok", true],
    ],
  );
  // The end frame yields system (sessionId learned only here) then result.
  assert.deepEqual(evs.slice(-2).map((e) => e.kind), ["system", "result"]);
  const system = evs.at(-2) as Extract<AgentEvent, { kind: "system" }>;
  assert.equal(system.sessionId, "019f91f3-e06c-7720-9680-1d904e8ba307");
  assert.equal(system.model, "grok-4.5-build");
  assert.equal(system.cwd, "/tmp/conan-probe");
  assert.equal(system.permissionMode, "default");
  const result = evs.at(-1) as Extract<AgentEvent, { kind: "result" }>;
  assert.equal(result.isError, false);
  assert.equal(result.costUsd, 0.0312664); // the float, never the ticks field
  assert.equal(result.numTurns, 1);
  assert.equal(result.text, "probe-ok"); // accumulated deltas
  assert.equal(result.contextTokens, 19995);
  assert.deepEqual(result.tokens, {
    input: 14747,
    cachedInput: 5248,
    output: 33,
    reasoningOutput: 26,
  });
});

test("grok parser: resume turn carries the SAME sessionId (2-turn continuity fixture)", () => {
  const evs = parseFixture("grok-turn2-resume.jsonl");
  const system = evs.find((e) => e.kind === "system")!;
  // Same session as turn 1 — the resume key round-trips.
  assert.equal(system.sessionId, "019f91f3-e06c-7720-9680-1d904e8ba307");
  const result = evs.find((e) => e.kind === "result")!;
  assert.equal(result.text, "probe-ok"); // answered from turn-1 context
  assert.equal(result.costUsd, 0.040816);
});

test("grok parser: Cancelled end → error result with an honest explanation, never a silent empty turn", () => {
  const evs = parseFixture("grok-approval-default.jsonl");
  // The approval-needing turn streams thoughts, then just ends Cancelled.
  const result = evs.find((e) => e.kind === "result") as Extract<
    AgentEvent,
    { kind: "result" }
  >;
  assert.equal(result.isError, true);
  assert.match(result.text!, /Cancelled/);
  assert.match(result.text!, /no headless tool approval/);
  // Cost is still real — the cancelled turn was billed.
  assert.equal(result.costUsd, 0.0313384);
});

test("grok parser: unknown event types and non-JSON noise are ignored, never thrown", () => {
  const parser = new GrokStreamParser({ cwd: null, mode: "default" });
  assert.deepEqual(parser.push("not json at all"), []);
  assert.deepEqual(parser.push(JSON.stringify({ type: "tool_call", data: "x" })), []);
  assert.deepEqual(parser.push(JSON.stringify({ type: "thought" })), []); // no data
  assert.deepEqual(parser.push(""), []);
});

test("grok args: prompt via -p, streaming-json, per-turn mode, resume by sessionId", () => {
  // Fresh turn — no resume flag.
  assert.deepEqual(
    buildGrokArgs({ cwd: "/w", mode: "default", sessionId: null, prompt: "hello" }),
    ["-p", "hello", "--output-format", "streaming-json", "--cwd", "/w", "--permission-mode", "default"],
  );
  // Resume turn with a model — continuity rides --resume <sessionId>.
  assert.deepEqual(
    buildGrokArgs({
      cwd: "/w",
      mode: "bypassPermissions",
      sessionId: "sid-1",
      model: "grok-4.5-build",
      prompt: "again",
    }),
    [
      "-p",
      "again",
      "--output-format",
      "streaming-json",
      "--cwd",
      "/w",
      "--permission-mode",
      "bypassPermissions",
      "-m",
      "grok-4.5-build",
      "--resume",
      "sid-1",
    ],
  );
});

test("grok image turns match the verified ACP fixture while text-only keeps -p", () => {
  const fixture = JSON.parse(
    readFileSync(join(here, "fixtures", "grok-image-prompt-json.json"), "utf8"),
  ) as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
  const source = fixture[0];
  assert.ok(source?.data);
  assert.ok(source.mimeType);
  const turn = {
    text: "Reply with exactly: ok",
    attachments: [],
    images: [
      {
        type: "image" as const,
        mediaType: source.mimeType,
        data: source.data,
        bytes: Buffer.from(source.data, "base64").byteLength,
        stagedPath: "/tmp/conan-images/pixel.png",
      },
    ],
  };
  assert.deepEqual(buildGrokPromptBlocks(turn), fixture);
  const args = buildGrokArgs({
    cwd: "/w",
    mode: "default",
    sessionId: null,
    prompt: turn.text,
    promptJson: buildGrokPromptBlocks(turn),
  });
  assert.deepEqual(args.slice(0, 2), ["--prompt-json", JSON.stringify(fixture)]);
  assert.equal(args.includes("-p"), false);
  assert.deepEqual(
    buildGrokPromptBlocks({ text: "plain", attachments: [] }),
    [{ type: "text", text: "plain" }],
  );
});

test("grok args apply only verified reasoning-effort values", () => {
  assert.deepEqual(
    buildGrokArgs({
      cwd: "/w",
      mode: "default",
      sessionId: null,
      effort: "medium",
      prompt: "hello",
    }),
    [
      "-p", "hello", "--output-format", "streaming-json", "--cwd", "/w",
      "--permission-mode", "default", "--reasoning-effort", "medium",
    ],
  );
});

test("grok mode mapping: shared vocabulary passes through, unknown → default", () => {
  assert.equal(grokModeFor("default"), "default");
  assert.equal(grokModeFor("plan"), "plan");
  assert.equal(grokModeFor("acceptEdits"), "acceptEdits");
  assert.equal(grokModeFor("bypassPermissions"), "bypassPermissions");
  // Grok-only modes are legal too (future US-009 chips send grok's own vocab).
  assert.equal(grokModeFor("auto"), "auto");
  assert.equal(grokModeFor("dontAsk"), "dontAsk");
  // The restrictive floor, never a silent bypass.
  assert.equal(grokModeFor(undefined), "default");
  assert.equal(grokModeFor("workspace-write"), "default");
});

test("grok driver: declares the verified capabilities; respondPermission is a no-op; mode switch applies next turn", () => {
  const events: AgentEvent[] = [];
  const driver = new GrokDriver((e) => events.push(e), () => null);
  assert.equal(driver.provider, "grok");
  assert.equal(driver.capabilities, GROK_CAPABILITIES);
  // No approval channel — answering a (nonexistent) request does nothing.
  driver.respondPermission("id", "accept");
  assert.deepEqual(events, []);
  // A mode switch is stored for the next spawn and confirmed honestly.
  driver.setPermissionMode("bypassPermissions");
  assert.deepEqual(events, [{ kind: "permission-mode", mode: "bypassPermissions" }]);
  driver.dispose();
});

test("grok parser: result counts cache_creation_input_tokens toward context window", () => {
  const parser = new GrokStreamParser({ cwd: "/tmp/conan-probe", mode: "default" });
  const events = parser.push(
    JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "sess-cache-create",
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 300,
        output_tokens: 50,
        reasoning_tokens: 10,
      },
      num_turns: 1,
    }),
  );
  const result = events.find((e) => e.kind === "result") as Extract<
    AgentEvent,
    { kind: "result" }
  >;
  assert.equal(result.contextTokens, 1500);
});
