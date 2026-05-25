// US-001 test: session-liveness reaper. Exercises the pure liveness helpers
// (pid check + marker-dir read) against a temp ~/.claude/sessions layout, then
// boots the real gateway on an isolated DB, seeds the kind of stale/synthetic
// rows that pile up in practice, runs reconcileSessions, and asserts:
//   - a stale 'running' row (dead pid, old activity) becomes 'dormant'
//   - a live row (pid in the marker set) and a recently-active row stay active
//   - synthetic test ids and event-less aged-out rows are GC'd
//   - with NO live processes, the Active Sessions (running) count is 0, not 53
//   - GET /api/claude/sessions reflects the reconciled status
//
// Run: tsx scripts/test-reaper.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-reaper-test-"));
const dataDir = path.join(tmp, "data");
const markersDir = path.join(tmp, "sessions");
fs.mkdirSync(markersDir, { recursive: true });
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { isPidAlive, readLiveSessionIds, reconcileSessions } = await import(
    "../src/session/reaper.ts"
  );

  // --- isPidAlive ---------------------------------------------------------
  check("current process pid is alive", isPidAlive(process.pid) === true);
  check("a definitely-dead pid is not alive", isPidAlive(2_147_483_000) === false);
  check("pid 0 is not alive", isPidAlive(0) === false);
  check("negative pid is not alive", isPidAlive(-1) === false);
  check("NaN pid is not alive", isPidAlive(NaN) === false);

  // --- readLiveSessionIds -------------------------------------------------
  // Marker for THIS process (alive) + a dead pid + an unparseable file.
  fs.writeFileSync(
    path.join(markersDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "live-uuid", cwd: tmp }),
  );
  fs.writeFileSync(
    path.join(markersDir, "2147483001.json"),
    JSON.stringify({ pid: 2_147_483_001, sessionId: "dead-uuid", cwd: tmp }),
  );
  fs.writeFileSync(path.join(markersDir, "garbage.json"), "{not json");
  fs.writeFileSync(path.join(markersDir, "ignore.txt"), "not a marker");

  const liveIds = readLiveSessionIds(markersDir);
  check("live marker's sessionId is reported live", liveIds.has("live-uuid"));
  check("dead marker's sessionId is not live", !liveIds.has("dead-uuid"));
  check("only the one live id is returned", liveIds.size === 1);
  check(
    "missing marker dir yields an empty set",
    readLiveSessionIds(path.join(tmp, "nope")).size === 0,
  );

  // --- gateway + DB reconcile --------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const { getDb } = await import("../src/db/index.ts");
  const db = getDb();
  const now = Date.now();
  const old = now - 60 * 60_000; // 1h ago — well outside the 5-min window
  const fresh = now - 30_000; // 30s ago — inside the window

  const upSession = db.prepare(
    `INSERT INTO session (id, status, created_at, last_activity)
       VALUES (@id, @status, @created, @last)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status,
       created_at = excluded.created_at, last_activity = excluded.last_activity`,
  );
  const insEvent = db.prepare(
    `INSERT INTO event (session_id, hook_event_name, stream_type, tool_name, payload, ts)
       VALUES (?, 'PreToolUse', 'stream_event', 'Bash', '{}', ?)`,
  );

  // Real rows carry events so they are demoted (not GC'd).
  upSession.run({ id: "live-uuid", status: "running", created: old, last: old });
  insEvent.run("live-uuid", old);
  upSession.run({ id: "stale-running", status: "running", created: old, last: old });
  insEvent.run("stale-running", old);
  upSession.run({ id: "stale-idle", status: "idle", created: old, last: old });
  insEvent.run("stale-idle", old);
  upSession.run({ id: "recent-running", status: "running", created: old, last: fresh });
  insEvent.run("recent-running", fresh);
  // GC targets: synthetic ids (even with an event) + an event-less aged row.
  upSession.run({ id: "sess-abc", status: "running", created: old, last: old });
  insEvent.run("sess-abc", old);
  upSession.run({ id: "demo-1", status: "idle", created: old, last: old });
  upSession.run({ id: "empty-old", status: "running", created: old, last: old });

  const before = db.prepare("SELECT COUNT(*) c FROM session").get();
  check("seeded 7 session rows", before.c === 7);

  // Reconcile with ONLY 'live-uuid' alive (the marker dir for the running
  // process isn't ~/.claude here, so inject the live set explicitly).
  const res = reconcileSessions({ now, liveIds: new Set(["live-uuid"]) });

  // stale-running -> dormant; live + recent kept; synthetics + empty-old GC'd.
  check("one stale 'running' row demoted (stale-running)", res.demoted === 1);
  check("three dead rows GC'd (sess-abc, demo-1, empty-old)", res.gced === 3);
  check("two rows remain active (live-uuid, recent-running)", res.active === 2);

  const statusOf = (id) =>
    db.prepare("SELECT status FROM session WHERE id = ?").get(id)?.status ?? null;
  check("stale-running demoted to dormant", statusOf("stale-running") === "dormant");
  check("stale-idle left as idle (already terminal-ish, not running)", statusOf("stale-idle") === "idle");
  check("live-uuid kept running", statusOf("live-uuid") === "running");
  check("recent-running kept running", statusOf("recent-running") === "running");
  check("sess-abc GC'd", statusOf("sess-abc") === null);
  check("demo-1 GC'd", statusOf("demo-1") === null);
  check("empty-old GC'd", statusOf("empty-old") === null);

  // Endpoint reflects the reconciled status.
  const rows = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  const runningFromApi = rows.filter((r) => r.status === "running").length;
  check("API running count = only truly-active (2)", runningFromApi === 2);

  // Criterion #5: with NO live processes (and the clock advanced so even the
  // recently-active row ages out), the count collapses to ~0, not 53 — the real
  // all-stale scenario the reaper exists to fix.
  const later = now + 10 * 60_000;
  const res2 = reconcileSessions({ now: later, liveIds: new Set() });
  check("no-live reconcile demotes the last running rows", res2.demoted >= 1);
  const rows2 = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  const runningNoLive = rows2.filter((r) => r.status === "running").length;
  check("with no live processes the running count is 0", runningNoLive === 0);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
