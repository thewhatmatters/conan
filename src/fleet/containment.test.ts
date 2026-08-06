// WHA-129 AC3: the containment resolution table. Containment is a property of
// (provider, permission_mode), not of the provider, so every case below pins a
// pair — and grok-default and kimi are named explicitly because the first draft
// of the freeze doc had both wrong (grok filed as uncontained when it actually
// fails closed; kimi, the one genuinely uncontained binding, missing entirely).
//
// Zero model calls, zero DB. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveContainment } from "./containment.js";

test("codex is os-sandbox except in its own danger-full-access mode", () => {
  assert.equal(resolveContainment("codex", "read-only"), "os-sandbox");
  assert.equal(resolveContainment("codex", "workspace-write"), "os-sandbox");
  // Claude-vocabulary modes reach codex through sandboxFor's mapping.
  assert.equal(resolveContainment("codex", "plan"), "os-sandbox");
  assert.equal(resolveContainment("codex", "acceptEdits"), "os-sandbox");
  // codex's own opt-out IS the absence of a sandbox — recorded honestly.
  assert.equal(resolveContainment("codex", "danger-full-access"), "none");
  assert.equal(resolveContainment("codex", "bypassPermissions"), "none");
  // Unknown modes floor to read-only in the driver, so they land contained.
  assert.equal(resolveContainment("codex", undefined), "os-sandbox");
  assert.equal(resolveContainment("codex", "whatever"), "os-sandbox");
});

test("claude is prompt-gated except in bypassPermissions", () => {
  assert.equal(resolveContainment("claude", "default"), "prompt-gated");
  assert.equal(resolveContainment("claude", "plan"), "prompt-gated");
  assert.equal(resolveContainment("claude", "acceptEdits"), "prompt-gated");
  assert.equal(resolveContainment("claude", undefined), "prompt-gated");
  // An id from another provider's vocabulary floors to `default`, not a bypass.
  assert.equal(resolveContainment("claude", "read-only"), "prompt-gated");
  assert.equal(resolveContainment("claude", "bypassPermissions"), "none");
});

test("grok default is fail-closed-cancel, not uncontained", () => {
  // Grok has NO headless approval channel: a tool needing approval ends the
  // turn `Cancelled`. That is containment — nobody can wave it through.
  assert.equal(resolveContainment("grok", "default"), "fail-closed-cancel");
  assert.equal(resolveContainment("grok", "plan"), "fail-closed-cancel");
  // grokModeFor floors every unknown id to `default`, so unknown input is safe.
  assert.equal(resolveContainment("grok", undefined), "fail-closed-cancel");
  assert.equal(resolveContainment("grok", "not-a-mode"), "fail-closed-cancel");
  // The grok-only auto-execute modes are recorded at the worst case: we have
  // not verified which tools still cancel under them.
  assert.equal(resolveContainment("grok", "auto"), "none");
  assert.equal(resolveContainment("grok", "dontAsk"), "none");
  assert.equal(resolveContainment("grok", "acceptEdits"), "none");
  assert.equal(resolveContainment("grok", "bypassPermissions"), "none");
});

test("kimi is none in every mode — headless -p rejects permission flags", () => {
  // The mode argument is informational for kimi; there is no mode that makes
  // it contained, so no mode may make it look contained.
  for (const mode of [undefined, "default", "plan", "read-only", "acceptEdits"]) {
    assert.equal(resolveContainment("kimi", mode), "none");
  }
});

test("an unknown provider resolves to none, never a silent pass", () => {
  assert.equal(resolveContainment("some-future-cli", "read-only"), "none");
  assert.equal(resolveContainment("", undefined), "none");
});
