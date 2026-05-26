// US-008 test: checkpoints — list ~/.claude/file-history/<session>/<hash>@vN
// snapshots (read-only) + single-snapshot content preview.
// Exercises the pure checkpoints module against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR), then the gateway routes end-to-end:
//   - lists snapshots as {sessionId, hash, version, mtime}, grouped per session
//   - version parsed from the @vN suffix; sessions sorted most-recent-first
//   - empty session dirs skipped; missing file-history dir → safe empty shape
//   - single-snapshot content fetch returns the file body; unknown → 404
//   - path-traversal in the id/hash can't escape the file-history dir
//
// Run: tsx scripts/test-checkpoints.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-checkpoints-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const fhDir = path.join(claudeDir, "file-history");
fs.mkdirSync(fhDir, { recursive: true });

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_CLAUDE_JSON = path.join(tmp, "dot-claude.json");
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed two sessions. Session A (older) has two files with multiple revisions;
// session B (newer) has one revision. A secret file outside file-history guards
// the traversal check.
const sessA = "0423718f-affd-41b2-8e9e-467df93d004f";
const sessB = "0950f54a-1216-4433-9a86-88665d1aadd0";
fs.mkdirSync(path.join(fhDir, sessA), { recursive: true });
fs.mkdirSync(path.join(fhDir, sessB), { recursive: true });
fs.mkdirSync(path.join(fhDir, "empty-session"), { recursive: true }); // no snapshots

const write = (sess, name, body, mtimeMs) => {
  const p = path.join(fhDir, sess, name);
  fs.writeFileSync(p, body);
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
};

const t0 = Date.now() - 100_000;
write(sessA, "0513421b9f1a1608@v1", "A-file1-v1", t0);
write(sessA, "0513421b9f1a1608@v2", "A-file1-v2", t0 + 1000);
write(sessA, "0be3faed1b471254@v3", "A-file2-v3", t0 + 2000);
// session B is the most recently active
write(sessB, "deadbeefcafef00d@v1", "B-file1-v1", Date.now());
// a non-snapshot file should be ignored
write(sessA, "README.txt", "ignore me", t0);

// secret outside file-history (sibling) for the traversal probe
fs.writeFileSync(path.join(claudeDir, "secret.txt"), "TOPSECRET");

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/checkpoints/index.ts");
  const out = mod.readCheckpoints();

  check("lists both non-empty sessions (empty skipped)", out.sessions.length === 2);
  check(
    "sessions sorted most-recently-active first (B then A)",
    out.sessions[0].sessionId === sessB && out.sessions[1].sessionId === sessA,
  );

  const a = out.sessions.find((s) => s.sessionId === sessA);
  check("session A has 3 snapshots (README ignored)", a.snapshots.length === 3);

  const v2 = a.snapshots.find((s) => s.hash === "0513421b9f1a1608" && s.version === 2);
  check("snapshot carries sessionId/hash/version/mtime", Boolean(
    v2 && v2.sessionId === sessA && typeof v2.mtime === "number" && v2.version === 2,
  ));
  check(
    "version parsed from @vN suffix",
    a.snapshots.every((s) => Number.isInteger(s.version)),
  );

  // --- single-snapshot content fetch --------------------------------------
  const snap = mod.readSnapshot(sessA, "0be3faed1b471254", 3);
  check("readSnapshot returns the file body", snap && snap.content === "A-file2-v3");
  check("readSnapshot reports its version", snap && snap.version === 3);
  check("readSnapshot unknown hash → null", mod.readSnapshot(sessA, "nope", 1) === null);
  check("readSnapshot unknown session → null", mod.readSnapshot("no-such-session", "x", 1) === null);

  // version omitted → first matching revision of the hash
  const anyRev = mod.readSnapshot(sessA, "0513421b9f1a1608", null);
  check("readSnapshot without version finds a revision", Boolean(anyRev && anyRev.hash === "0513421b9f1a1608"));

  // --- traversal guard ----------------------------------------------------
  check(
    "traversal session id can't escape file-history",
    mod.readSnapshot("../", "secret", null) === null &&
      mod.readSnapshot("..", "secret", null) === null,
  );

  // --- missing file-history dir → safe empty shape ------------------------
  fs.rmSync(fhDir, { recursive: true, force: true });
  const empty = mod.readCheckpoints();
  check("missing file-history → empty sessions", Array.isArray(empty.sessions) && empty.sessions.length === 0);
  check("missing file-history → readSnapshot null", mod.readSnapshot(sessA, "0513421b9f1a1608", 1) === null);

  // restore for the gateway round-trip
  fs.mkdirSync(path.join(fhDir, sessB), { recursive: true });
  write(sessB, "deadbeefcafef00d@v1", "B-file1-v1", Date.now());

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/checkpoints`)).json();
  check("GET /api/claude/checkpoints lists sessions", Array.isArray(g.sessions) && g.sessions.length === 1);
  check("GET snapshot shape intact", g.sessions[0].snapshots[0].hash === "deadbeefcafef00d");

  const c = await fetch(
    `${BASE}/api/claude/checkpoints/${sessB}/content?hash=deadbeefcafef00d&version=1`,
  );
  const cj = await c.json();
  check("GET content returns the snapshot body", c.status === 200 && cj.content === "B-file1-v1");

  const miss = await fetch(`${BASE}/api/claude/checkpoints/${sessB}/content?hash=nope&version=9`);
  check("GET content unknown → 404", miss.status === 404);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
