// readCommands() backs the composer's `/` autocomplete (US-020). It must name
// commands by relative path (`:`-joined namespacing), prefer frontmatter
// descriptions with an honest first-body-line fallback, surface argument-hint,
// let a custom command shadow a same-named built-in, and degrade to just the
// verified built-ins when no command roots exist. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCommands, HEADLESS_BUILTINS } from "./index.js";

/** Scratch cwd with a .claude/commands tree built from {relPath: content}. */
function scratch(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-cmds-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ".claude", "commands", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("empty project root → no project entries, verified built-ins present", () => {
  const cmds = readCommands(fs.mkdtempSync(path.join(os.tmpdir(), "conan-empty-")));
  assert.equal(cmds.filter((c) => c.source === "project").length, 0);
  // Built-ins survive unless a user command on this machine shadows the name.
  const userNames = new Set(cmds.filter((c) => c.source === "user").map((c) => c.name));
  const expected = HEADLESS_BUILTINS.filter((b) => !userNames.has(b.name));
  assert.deepEqual(cmds.filter((c) => c.source === "built-in"), expected);
  for (const b of expected) assert.equal(typeof b.description, "string");
});

test("project command file → entry with frontmatter description + hint", () => {
  const cwd = scratch({
    "deploy.md": "---\ndescription: Ship it\nargument-hint: [env]\n---\nDeploy the app to $1.\n",
  });
  const c = readCommands(cwd).find((c) => c.name === "deploy");
  assert.ok(c);
  assert.equal(c.source, "project");
  assert.equal(c.description, "Ship it");
  assert.equal(c.argumentHint, "[env]");
});

test("no frontmatter → first non-empty body line, heading marker stripped", () => {
  const cwd = scratch({ "notes.md": "\n\n## Take notes\nBody here.\n" });
  const c = readCommands(cwd).find((c) => c.name === "notes");
  assert.equal(c?.description, "Take notes");
});

test("subdirectories namespace with a colon", () => {
  const cwd = scratch({ "frontend/component.md": "Make a component.\n" });
  const c = readCommands(cwd).find((c) => c.name === "frontend:component");
  assert.ok(c);
  assert.equal(c.description, "Make a component.");
});

test("non-md and dotfiles are skipped", () => {
  const cwd = scratch({ "cmd.md": "Real.\n", "readme.txt": "Not a command.\n", ".hidden.md": "No.\n" });
  const names = readCommands(cwd).map((c) => c.name);
  assert.ok(names.includes("cmd"));
  assert.ok(!names.includes("readme"));
  assert.ok(!names.some((n) => n.includes("hidden")));
});

test("custom command shadows the same-named built-in", () => {
  const cwd = scratch({ "review.md": "---\ndescription: House review flow\n---\nDo it our way.\n" });
  const reviews = readCommands(cwd).filter((c) => c.name === "review");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.source, "project");
});

test("null cwd still returns user + built-in commands", () => {
  const cmds = readCommands(null);
  assert.ok(cmds.some((c) => c.name === "compact" && c.source === "built-in"));
  assert.ok(!cmds.some((c) => c.source === "project"));
});
