// WHA-139 (B1): Sagan marker detection. The state that matters most is the one
// that is easy to get wrong — a present-but-broken overlay must not read as
// "not a Sagan project", because those look identical from the outside and only
// one of them is something a human can fix.
//
// Real files on disk; no DB, no model calls. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectSagan, MARKER } from "./detect.js";

/** A repo root, optionally carrying a `.sagan/sagan.yaml` with `body`. */
function repo(name: string, body?: string): { root: string; nested: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `conan-sagan-${name}-`));
  const root = path.join(base, "repo");
  const nested = path.join(root, "packages", "api");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  if (body !== undefined) {
    fs.mkdirSync(path.join(root, ".sagan"), { recursive: true });
    fs.writeFileSync(path.join(root, MARKER), body);
  }
  return { root, nested };
}

/** Trimmed from the reference repo's own `.sagan/sagan.yaml` @ ab2cb8d. */
const V0_MANIFEST = `# sagan v0 test config
runtime: claude-code-session
validation: pm-interpreted
enforced: []

pm:
  binding: { provider: claude-code }
  state: ledger

providers:
  claude: { containment: prompt-gated }

bindings:
  frontend: { provider: claude }

rules:
  ac_before_dispatch: required
`;

test("a v0 manifest at the repo root is valid", () => {
  const { root } = repo("valid", V0_MANIFEST);
  const cap = detectSagan(root);
  assert.equal(cap.state, "valid");
  assert.equal(cap.root, root);
  assert.equal(cap.manifestPath, path.join(root, MARKER));
  // v0 declares no version field; absence must not read as unsupported.
  assert.equal(cap.version, null);
});

test("a nested cwd sees the project's marker", () => {
  const { root, nested } = repo("nested", V0_MANIFEST);
  const cap = detectSagan(nested);
  assert.equal(cap.state, "valid", "root is the repo, not the cwd");
  assert.equal(cap.root, root);
});

test("no marker is absent, not invalid", () => {
  const { root } = repo("bare");
  const cap = detectSagan(root);
  assert.equal(cap.state, "absent");
  assert.equal(cap.manifestPath, null);
});

test("an empty marker is invalid and says so — never absent", () => {
  const { root } = repo("empty", "");
  const cap = detectSagan(root);
  assert.equal(cap.state, "invalid");
  assert.match(cap.reason ?? "", /empty/);
  assert.ok(cap.manifestPath, "a broken overlay must still name its file");
});

test("a file with no Sagan keys is invalid", () => {
  const { root } = repo("stray", "hello: world\nnot: a manifest\n");
  const cap = detectSagan(root);
  assert.equal(cap.state, "invalid");
  assert.match(cap.reason ?? "", /recognisable/);
});

test("comments and indented keys never make a file look like a manifest", () => {
  // `rules:` appears, but only as a comment and as a nested key — neither is
  // this document declaring a Sagan manifest.
  const { root } = repo("decoys", "# rules: required\nfoo:\n  rules: nope\n");
  assert.equal(detectSagan(root).state, "invalid");
});

test("an unknown schema version is refused, not guessed at", () => {
  const { root } = repo("future", `schemaVersion: 7\n${V0_MANIFEST}`);
  const cap = detectSagan(root);
  assert.equal(cap.state, "unsupported-version");
  assert.equal(cap.version, "7");
  assert.match(cap.reason ?? "", /does not support/);
});

test("a known version is valid and reported", () => {
  const { root } = repo("versioned", `version: "1"\n${V0_MANIFEST}`);
  const cap = detectSagan(root);
  assert.equal(cap.state, "valid");
  assert.equal(cap.version, "1");
});

test("a trailing comment does not become part of the version", () => {
  const { root } = repo("commented", `schemaVersion: 1  # bump me\n${V0_MANIFEST}`);
  const cap = detectSagan(root);
  assert.equal(cap.version, "1");
  assert.equal(cap.state, "valid");
});

test("a directory where the marker should be is invalid, not absent", () => {
  const { root } = repo("dirmarker");
  fs.mkdirSync(path.join(root, MARKER), { recursive: true });
  // readFileSync throws EISDIR. Only ENOENT means "not a Sagan project"; an
  // unreadable marker is a broken overlay and the reason has to survive.
  const cap = detectSagan(root);
  assert.equal(cap.state, "invalid");
  assert.match(cap.reason ?? "", /EISDIR|could not be read/);
});

test("no cwd is absent", () => {
  const cap = detectSagan(null);
  assert.equal(cap.state, "absent");
  assert.equal(cap.root, null);
});

test("a marker outside any repo still counts from the folder itself", () => {
  // Sagan overlays a repo, but a plain folder opened as a project should not be
  // silently ignored just because it is not under git.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "conan-sagan-nogit-"));
  fs.mkdirSync(path.join(base, ".sagan"), { recursive: true });
  fs.writeFileSync(path.join(base, MARKER), V0_MANIFEST);
  assert.equal(detectSagan(base).state, "valid");
});
