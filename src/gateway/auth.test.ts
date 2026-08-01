// Origin allow-listing for the WS upgrade and the CORS reflector (WHA-8).
// The regression this pins: the allow-list used to hardcode the Vite dev origin
// as :5173, so a preview stack on any other port had every /ws/agent upgrade
// refused while the page itself loaded fine — the UI just said "connection
// lost". Loopback is now accepted on any port, and the CVE-2025-52882 floor is
// unchanged: a remote origin still cannot pass, and neither can a lookalike
// host that merely starts with a loopback address. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set before importing: the module resolves its auth token at load and would
// otherwise generate and persist one into the repo's .data directory.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-auth-test-"));
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = "test-token";

const { isAllowedOrigin } = await import("./auth.js");

test("accepts a loopback origin on any port — the WHA-8 regression", () => {
  // :5230 and :5199 are real preview ports that used to be refused.
  assert.equal(isAllowedOrigin("http://127.0.0.1:5230"), true);
  assert.equal(isAllowedOrigin("http://localhost:5230"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:5199"), true);
  assert.equal(isAllowedOrigin("http://[::1]:5230"), true);
  // Anywhere in 127.0.0.0/8, not just 127.0.0.1.
  assert.equal(isAllowedOrigin("http://127.0.0.2:8080"), true);
});

test("still accepts the origins the explicit list exists for", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:5173"), true);
  assert.equal(isAllowedOrigin("tauri://localhost"), true);
  assert.equal(isAllowedOrigin("http://tauri.localhost"), true);
  assert.equal(isAllowedOrigin("https://tauri.localhost"), true);
});

test("refuses remote origins — the CVE-2025-52882 floor", () => {
  assert.equal(isAllowedOrigin("http://evil.com"), false);
  assert.equal(isAllowedOrigin("https://evil.com"), false);
  assert.equal(isAllowedOrigin("http://192.168.1.128:5230"), false);
});

test("refuses hosts that only look like loopback", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com"), false);
  assert.equal(isAllowedOrigin("http://localhost.evil.com"), false);
  assert.equal(isAllowedOrigin("http://evil.com/127.0.0.1"), false);
  // Not 127.0.0.0/8, despite the leading digits.
  assert.equal(isAllowedOrigin("http://12.7.0.1:5230"), false);
  assert.equal(isAllowedOrigin("http://1270.0.0.1:5230"), false);
});

test("refuses a loopback host on a non-http scheme", () => {
  // The tauri:// entries are allow-listed by name; the loopback widening must
  // not let an arbitrary custom scheme in just because its host is localhost.
  assert.equal(isAllowedOrigin("ftp://127.0.0.1:5230"), false);
  assert.equal(isAllowedOrigin("file://localhost"), false);
});

test("garbage and absent origins behave as before", () => {
  assert.equal(isAllowedOrigin("not a url"), false);
  assert.equal(isAllowedOrigin(""), false);
  // A missing Origin header is not a browser request; unchanged from before.
  assert.equal(isAllowedOrigin(undefined), true);
});
