// 1.0.3: parseContextFrame must recognize new model families (the Claude 5
// line introduced "claude-fable-5"), not just opus/sonnet/haiku — the 1.0.2
// parser returned model: null for the Fable header even though tokens and
// categories parsed fine. Synthetic frames mirror the /context TUI shape
// post-ANSI-strip. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContextFrame } from "./index.js";

const FABLE_FRAME = `
  Context Usage
  claude-fable-5 · 53.2k/1m tokens (5%)

  System prompt: 3.2k tokens (0.3%)
  System tools: 11.1k tokens (1.1%)
  MCP tools: 8.4k tokens (0.8%)
  Memory files: 4.9k tokens (0.5%)
  Skills: 2.1k tokens (0.2%)
  Messages: 23.5k tokens (2.4%)
  Free space: 946k (94.7%)
`;

test("fable-5 header parses: slug, display name, and 1M window marker", () => {
  const parsed = parseContextFrame(FABLE_FRAME);
  assert.ok(parsed, "frame should parse");
  assert.equal(parsed.model, "claude-fable-5");
  assert.equal(parsed.modelDisplay, "Claude Fable 5 (1M)");
  assert.equal(parsed.usedTokens, 53_200);
  assert.equal(parsed.windowTokens, 1_000_000);
  assert.equal(parsed.usedPct, 5);
  assert.equal(parsed.categories.length, 7);
});

test("dotted-version slugs still parse (claude-opus-4-7 → Claude Opus 4.7)", () => {
  const parsed = parseContextFrame(`
    Context Usage
    claude-opus-4-7 · 60k/200k tokens (30%)
    Messages: 50k tokens (25%)
  `);
  assert.ok(parsed);
  assert.equal(parsed.model, "claude-opus-4-7");
  assert.equal(parsed.modelDisplay, "Claude Opus 4.7");
});

test("non-model claude-* runs (claude-in-chrome) are not captured as a slug", () => {
  const parsed = parseContextFrame(`
    Context Usage
    60k/200k tokens (30%)
    Messages: claude-in-chrome discussion 50k tokens (25%)
  `);
  assert.ok(parsed);
  assert.equal(parsed.model, null);
  assert.equal(parsed.modelDisplay, null);
});
