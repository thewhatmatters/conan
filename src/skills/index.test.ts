// frontmatterField() backs the Skills HUD tab's descriptions AND the BM25
// skills-considered heuristic (match.ts scores over the description). It must
// read plain `key: value` lines and YAML block scalars (`>-`/`|`) — skills
// whose descriptions contain `: ` on continuation lines are forced into the
// block-scalar form, and returning the bare `>-` sigil (the pre-fix bug)
// rendered garbage in the panel and poisoned BM25 scoring. Honest-by-
// construction: anything unreadable must come back null, never fabricated.
// Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { frontmatterDescription, frontmatterField } from "./index.js";

/** Wrap frontmatter body lines in the `---` fence + a markdown body. */
function doc(...fm: string[]): string {
  return `---\n${fm.join("\n")}\n---\n\n# Body\n`;
}

test("plain single-line value", () => {
  assert.equal(frontmatterDescription(doc("name: x", "description: Does a thing.")), "Does a thing.");
  assert.equal(frontmatterField(doc("name: my-skill"), "name"), "my-skill");
});

test("strips one matched surrounding quote pair", () => {
  assert.equal(frontmatterDescription(doc('description: "Quoted."')), "Quoted.");
  assert.equal(frontmatterDescription(doc("description: 'Single.'")), "Single.");
});

test("folded block scalar (>-) joins continuation lines with spaces", () => {
  const text = doc(
    "name: announce",
    "description: >-",
    "  Fan out a release announcement across three surfaces: the marketing",
    "  changelog, the in-app popup, and a draft buyer email.",
    "license: MIT",
  );
  assert.equal(
    frontmatterDescription(text),
    "Fan out a release announcement across three surfaces: the marketing changelog, the in-app popup, and a draft buyer email.",
  );
  // The block must not swallow the following key.
  assert.equal(frontmatterField(text, "license"), "MIT");
});

test("folded block scalar tolerates `: ` on continuation lines (the trap that forces >-)", () => {
  const text = doc(
    "description: >-",
    "  Use when: the user asks for X. Also covers: Y and Z.",
    "  Second line: with more colons.",
  );
  assert.equal(
    frontmatterDescription(text),
    "Use when: the user asks for X. Also covers: Y and Z. Second line: with more colons.",
  );
});

test("literal block scalar (|) keeps newlines", () => {
  const text = doc("description: |", "  line one", "  line two");
  assert.equal(frontmatterDescription(text), "line one\nline two");
});

test("block scalar headers with chomping/indent indicators parse", () => {
  for (const header of [">", ">+", ">2", ">2-", "|-", "|+"]) {
    const text = doc(`description: ${header}`, "  the body text");
    assert.equal(frontmatterDescription(text), "the body text", `header ${header}`);
  }
});

test("blank lines inside a folded block are absorbed, trailing blanks trimmed", () => {
  const text = doc("description: >-", "  para one.", "", "  para two.", "", "other: x");
  assert.equal(frontmatterDescription(text), "para one. para two.");
});

test("bare block header with no body returns null — never the sigil", () => {
  assert.equal(frontmatterDescription(doc("description: >-", "name: x")), null);
  assert.equal(frontmatterDescription(doc("description: >-")), null);
});

test("missing key, empty value, and missing frontmatter all return null", () => {
  assert.equal(frontmatterDescription(doc("name: x")), null);
  assert.equal(frontmatterDescription(doc("description:")), null);
  assert.equal(frontmatterDescription("# no frontmatter\n"), null);
});

test("indented lines never match as keys (plain multiline continuations are not keys)", () => {
  const text = doc("description: starts here", "  continuation: with colon");
  // The parser reads only the first line of a plain scalar — the (invalid-YAML)
  // continuation is ignored rather than misread as a `continuation:` key.
  assert.equal(frontmatterDescription(text), "starts here");
  assert.equal(frontmatterField(text, "continuation"), null);
});
