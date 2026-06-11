// US-006 (1.0.2): parser fixture tests against a REAL Claude Code 2.1.173
// /usage capture (scripts/capture-usage-frame.mjs — raw pty stream, ANSI
// intact). The fixture's whole point: the "Current week (Sonnet only)" window
// arrives as a delta repaint, so it is only recoverable from reconstructed
// screen state — parsing the raw stream directly must keep missing it, and the
// reconstruction path must find it. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsageFrame } from "./probe.js";
import { reconstructScreenText } from "./screen.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/usage-frame.txt", import.meta.url));
const raw = readFileSync(FIXTURE, "utf8");

test("reconstructed 2.1.173 frame parses all three windows, incl. Sonnet-only 0%", async () => {
  const screen = await reconstructScreenText(raw, 120, 40);
  assert.match(screen, /Current week \(Sonnet only\)/);

  const parsed = parseUsageFrame(screen);
  assert.ok(parsed, "frame should parse");
  assert.equal(parsed.fiveHour?.utilizationPct, 25);
  assert.equal(parsed.sevenDay?.utilizationPct, 3);
  // The Sonnet window renders "0% used" — 0 must parse as a present window
  // with utilizationPct 0, not collapse to null/absent.
  assert.ok(parsed.sevenDaySonnet, "Sonnet-only window should be present");
  assert.equal(parsed.sevenDaySonnet.utilizationPct, 0);
  // "0% used" renders with no Resets line of its own in this frame.
  assert.equal(parsed.sevenDaySonnet.resetAt, null);
  assert.equal(parsed.status, "ok");
});

test("raw delta stream alone cannot see the Sonnet window (why reconstruction exists)", () => {
  // Guard the fixture's premise: if a future Claude Code goes back to full
  // repaints, this fails and the reconstruction layer can be revisited.
  const parsed = parseUsageFrame(raw);
  assert.ok(parsed, "the fast windows do parse from the raw stream");
  assert.equal(parsed.sevenDaySonnet, null);
});
