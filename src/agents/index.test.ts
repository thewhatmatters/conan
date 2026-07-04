// readAgentsRoot() backs the Agents HUD tab: it must discover flat `*.md`
// agent files (NOT `<dir>/SKILL.md` like skills), skip the `.md.tmpl`
// templates plugins ship alongside, and fall back to the filename when the
// frontmatter has no `name:`. Frontmatter parsing itself is covered by
// src/skills/index.test.ts (shared frontmatterField) — these tests cover the
// filesystem shape. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentsRoot } from "./index.js";

/** A temp agents root populated with the given { filename: content } map. */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conan-agents-test-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

const AGENT_MD = `---
name: skill-auditor
description: "Read-only auditor for one skill directory."
tools: Read, Grep, Glob, Bash
---

You are an audit agent.
`;

test("discovers flat .md files with frontmatter name/description/tools", () => {
  const root = fixture({ "auditor.md": AGENT_MD });
  const agents = readAgentsRoot(root, "User");
  assert.equal(agents.length, 1);
  const a = agents[0]!;
  assert.equal(a.name, "skill-auditor");
  assert.equal(a.description, "Read-only auditor for one skill directory.");
  assert.equal(a.tools, "Read, Grep, Glob, Bash");
  assert.equal(a.model, null);
  assert.equal(a.source, "User");
  assert.ok(a.path?.endsWith("auditor.md"));
});

test("skips .md.tmpl templates and non-markdown files", () => {
  const root = fixture({
    "real.md": AGENT_MD,
    "real.md.tmpl": AGENT_MD,
    "notes.txt": "not an agent",
    ".DS_Store": "junk",
  });
  const agents = readAgentsRoot(root, "Plugin", "vercel@claude-plugins-official");
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.plugin, "vercel@claude-plugins-official");
});

test("name falls back to the filename when frontmatter has no name", () => {
  const root = fixture({ "my-agent.md": "---\ndescription: Helper.\n---\nBody\n" });
  const agents = readAgentsRoot(root, "User");
  assert.equal(agents[0]!.name, "my-agent");
  assert.equal(agents[0]!.description, "Helper.");
});

test("missing description → null, never fabricated", () => {
  const root = fixture({ "bare.md": "---\nname: bare\n---\nBody\n" });
  const agents = readAgentsRoot(root, "User");
  assert.equal(agents[0]!.description, null);
});

test("no frontmatter at all → filename name, null description", () => {
  const root = fixture({ "plain.md": "# Just markdown\n" });
  const agents = readAgentsRoot(root, "User");
  assert.equal(agents[0]!.name, "plain");
  assert.equal(agents[0]!.description, null);
});

test("absent root → empty list", () => {
  assert.deepEqual(readAgentsRoot("/nonexistent/agents-root", "User"), []);
});

test("a directory named *.md is skipped", () => {
  const root = fixture({});
  fs.mkdirSync(path.join(root, "dir.md"));
  assert.deepEqual(readAgentsRoot(root, "User"), []);
});

test("entries come back sorted by filename", () => {
  const root = fixture({
    "b.md": "---\nname: bravo\n---\n",
    "a.md": "---\nname: alpha\n---\n",
  });
  const agents = readAgentsRoot(root, "User");
  assert.deepEqual(agents.map((a) => a.name), ["alpha", "bravo"]);
});
