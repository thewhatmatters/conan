// WHA-96: the `/ws/agent` handler re-sends the capabilities frame on every
// `system` event so a provider's REPORTED model can refine the context-window
// denominator. `refineCapabilities` is the rule that re-send folds through —
// a reported model may correct the window, never erase one the launch model
// already established. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refineCapabilities } from "./index.js";
import {
  getProvider,
  capabilitiesFor,
  capabilitiesForReportedModel,
} from "./registry.js";

/** The frame the client actually receives: launch descriptor folded with the
 *  one resolved from whatever model the provider reported at init. */
function windowAfterInit(
  providerId: string,
  launchModel: string | undefined,
  reportedModel: string | null,
): number | null {
  const provider = getProvider(providerId)!;
  return refineCapabilities(
    capabilitiesFor(provider, launchModel),
    capabilitiesForReportedModel(provider, reportedModel),
  ).contextWindowTokens;
}

test("an unresolvable reported model keeps the launch denominator", () => {
  // grok reports a build name (`grok-4.5-build`, see fixtures/grok-turn1.jsonl)
  // that CONTEXT_WINDOWS has no entry for; the 500k launch value must survive.
  assert.equal(windowAfterInit("grok", undefined, "grok-4.5-build"), 500_000);
});

test("a provider that reports no model at all keeps the launch denominator", () => {
  // kimi and codex never report a model in-stream.
  assert.equal(windowAfterInit("kimi", undefined, null), 1_048_576);
  assert.equal(windowAfterInit("codex", "gpt-5.5", null), 272_000);
});

test("a reported model that resolves refines the launch denominator", () => {
  // The whole point of the re-send: "Default model" guesses 200k, the CLI
  // reports the model it really launched, and the meter corrects to 1M.
  assert.equal(capabilitiesFor(getProvider("claude")!).contextWindowTokens, 200_000);
  assert.equal(windowAfterInit("claude", undefined, "claude-fable-5"), 1_000_000);
});

test("a resolved reported model wins even when it is smaller than the launch guess", () => {
  // Not merely max(): the reported model names what actually ran, so a
  // narrower window is a correction, not a regression to guard against.
  assert.equal(windowAfterInit("claude", "claude-fable-5", "sonnet"), 200_000);
});

test("unknown on both sides stays null rather than inventing a denominator", () => {
  assert.equal(windowAfterInit("codex", undefined, null), null);
});

test("no launch descriptor yet leaves the reported frame untouched", () => {
  const reported = capabilitiesForReportedModel(getProvider("claude")!, "claude-fable-5");
  assert.deepEqual(refineCapabilities(null, reported), reported);
});

test("every capability except the window comes from the reported descriptor", () => {
  const claude = getProvider("claude")!;
  const launch = capabilitiesFor(claude, undefined);
  const reported = capabilitiesForReportedModel(claude, "grok-shaped-nonsense");
  const merged = refineCapabilities(launch, reported);
  assert.deepEqual({ ...merged, contextWindowTokens: null }, { ...reported, contextWindowTokens: null });
  assert.equal(merged.contextWindowTokens, 200_000);
});
