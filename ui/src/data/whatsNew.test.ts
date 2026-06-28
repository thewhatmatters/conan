import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWhatsNew, WHATS_NEW } from "./whatsNew.ts";

// A version we know has an entry, and one we know doesn't, derived from the
// real table so the test tracks reality rather than a hardcoded guess.
const WITH_ENTRY = Object.keys(WHATS_NEW)[0]!; // e.g. "1.0.6"
const NO_ENTRY = "9.9.9";

test("fresh install (never run before) shows nothing — Onboarding owns first run", () => {
  assert.equal(
    decideWhatsNew({ version: WITH_ENTRY, lastSeen: null, hasRunBefore: false }),
    null,
  );
});

test("returning user, feature's debut release (lastSeen null) → shows the entry", () => {
  const r = decideWhatsNew({
    version: WITH_ENTRY,
    lastSeen: null,
    hasRunBefore: true,
  });
  assert.equal(r?.version, WITH_ENTRY);
});

test("returning user updating from a prior version → shows the entry", () => {
  const r = decideWhatsNew({
    version: WITH_ENTRY,
    lastSeen: "1.0.0",
    hasRunBefore: true,
  });
  assert.equal(r?.version, WITH_ENTRY);
});

test("already shown for this version (lastSeen === version) → shows nothing", () => {
  assert.equal(
    decideWhatsNew({
      version: WITH_ENTRY,
      lastSeen: WITH_ENTRY,
      hasRunBefore: true,
    }),
    null,
  );
});

test("version with no entry (a quiet patch) → shows nothing even on a real update", () => {
  assert.equal(
    decideWhatsNew({ version: NO_ENTRY, lastSeen: "1.0.0", hasRunBefore: true }),
    null,
  );
});

test("missing/unknown version → shows nothing", () => {
  assert.equal(
    decideWhatsNew({ version: null, lastSeen: "1.0.0", hasRunBefore: true }),
    null,
  );
  assert.equal(
    decideWhatsNew({ version: undefined, lastSeen: null, hasRunBefore: true }),
    null,
  );
});
