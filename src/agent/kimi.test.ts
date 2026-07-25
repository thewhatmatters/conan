// KimiDriver: the stream-json parser against the captured kimi 0.27.0 fixtures
// (no live kimi calls — fixtures are the verified ground truth), the argv
// builder, and the verified capability descriptor. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIMI_CAPABILITIES, KimiDriver, KimiStreamParser, buildKimiArgs } from "./kimi.js";
import type { AgentEvent } from "./driver.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Run every line of a fixture through a fresh parser. */
function parseFixture(name: string): AgentEvent[] {
  const parser = new KimiStreamParser({ cwd: "/tmp/conan-probe" });
  const out: AgentEvent[] = [];
  for (const line of readFileSync(join(here, "fixtures", name), "utf8").split("\n")) {
    out.push(...parser.push(line));
  }
  return out;
}

test("kimi parser: text turn → whole-block assistant text, then system + result from the resume-hint", () => {
  const evs = parseFixture("kimi-turn-text.jsonl");

  // Assistant prose is a WHOLE block (no deltas) — streamingDeltas is false.
  const text = evs.filter((e) => e.kind === "assistant-text");
  assert.equal(text.length, 1);
  assert.equal(text[0]!.text, "ok");
  assert.notEqual(text[0]!.delta, true);

  // The closing resume-hint meta yields system (with the sessionId) then result.
  const system = evs.find((e) => e.kind === "system");
  assert.ok(system && system.kind === "system");
  assert.equal(system.sessionId, "session_c75632c0-50e4-4742-adf5-49ba1b4f0b8f");
  assert.equal(system.model, null); // kimi reports no model in-stream
  assert.deepEqual(system.tools, []);

  const result = evs.find((e) => e.kind === "result");
  assert.ok(result && result.kind === "result");
  assert.equal(result.isError, false);
  assert.equal(result.costUsd, null); // no cost in the stream (subscription)
  assert.equal(result.contextTokens, null);
  assert.equal(result.text, "ok"); // accumulated → thread preview

  // Ordering: system precedes result (the WS handler upserts on the sessionId).
  assert.ok(evs.indexOf(system!) < evs.indexOf(result!));
});

test("kimi parser: tool turn → tool-use (parsed args) + tool-result correlated by id", () => {
  const evs = parseFixture("kimi-turn-tools.jsonl");

  const use = evs.find((e) => e.kind === "tool-use");
  assert.ok(use && use.kind === "tool-use");
  assert.equal(use.name, "Bash");
  assert.equal(use.id, "tool_w2k94cHRAfVedoFFr0b34UoP");
  // arguments is a JSON STRING on the wire; the parser decodes it to an object.
  assert.deepEqual(use.input, { command: "echo hello-from-kimi" });

  const res = evs.find((e) => e.kind === "tool-result");
  assert.ok(res && res.kind === "tool-result");
  assert.equal(res.id, use.id); // correlated by tool_call_id
  assert.equal(res.content, "hello-from-kimi\n");
  assert.equal(res.isError, false);

  // The final assistant message still becomes the result text.
  const result = evs.find((e) => e.kind === "result");
  assert.ok(result && result.kind === "result");
  assert.match(result.text ?? "", /ran successfully/);
});

test("kimi parser: non-JSON and unknown records are ignored, never thrown", () => {
  const parser = new KimiStreamParser({ cwd: null });
  assert.deepEqual(parser.push("not json at all"), []);
  assert.deepEqual(parser.push(""), []);
  assert.deepEqual(parser.push('{"role":"future-kind","x":1}'), []);
});

test("kimi argv: prompt on -p, stream-json, -m alias, -r resume; no permission flag", () => {
  assert.deepEqual(buildKimiArgs({ sessionId: null, prompt: "hi" }), [
    "-p",
    "hi",
    "--output-format",
    "stream-json",
  ]);
  assert.deepEqual(
    buildKimiArgs({ sessionId: "session_abc", model: "kimi-code/k3", prompt: "go" }),
    ["-p", "go", "--output-format", "stream-json", "-m", "kimi-code/k3", "-r", "session_abc"],
  );
});

test("kimi capabilities: whole-message, no approval channel, subscription (no USD), model choice", () => {
  assert.equal(KIMI_CAPABILITIES.streamingDeltas, false);
  assert.equal(KIMI_CAPABILITIES.interactiveApproval, false);
  assert.equal(KIMI_CAPABILITIES.livePermissionSwitch, false);
  assert.equal(KIMI_CAPABILITIES.costUsd, false);
  assert.equal(KIMI_CAPABILITIES.resume, true);
  assert.equal(KIMI_CAPABILITIES.modelSelection, true);
  // Headless kimi auto-approves — a single honest Full-access mode (renders red
  // via the UI's danger-full-access id).
  assert.deepEqual(
    KIMI_CAPABILITIES.permissionModes.map((m) => m.id),
    ["danger-full-access"],
  );
  // Verified `kimi provider list --json` model set; default first (null value).
  assert.equal(KIMI_CAPABILITIES.models[0]!.value, null);
  assert.ok(KIMI_CAPABILITIES.models.some((m) => m.value === "kimi-code/k3"));
});

test("kimi driver: tagged with its own provider id", () => {
  const driver = new KimiDriver(
    () => {},
    () => null,
  );
  assert.equal(driver.provider, "kimi");
  driver.dispose();
});
