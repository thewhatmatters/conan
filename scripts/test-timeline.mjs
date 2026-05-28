// US-001 (v4.5) test: Timeline envelope mapping + the route.
// Pure half covers mapHookEventToRow for each documented hook subtype,
// mapActivityLineToRow + the timestamp parser, and buildTimeline (since/limit/
// clamp/cwd-gate). Integration half boots the real gateway on an isolated DB,
// posts a few hook events, and asserts GET /api/claude/timeline returns the
// right envelopes, auth-gates, empties unknown sessions, and clamps limits.
//
// CRITICAL: CONAN_DATA_DIR is read at module import time (src/paths.ts), so we
// must set it before importing ANY src/* module — otherwise the timeline
// module's first import would freeze DB_PATH at the production .data path and
// the integration half would write into the dev DB, picking up stale rows.
//
// Run: tsx scripts/test-timeline.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-timeline-test-"));
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3500 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

// Build an EventRow-shaped object — only the fields mapHookEventToRow reads.
let nextId = 1;
const hookEv = (hook_event_name, payload, ts, tool_name = null) => ({
  id: nextId++,
  session_id: "s",
  parent_tool_use_id: null,
  hook_event_name,
  stream_type: "hook",
  tool_name,
  payload: JSON.stringify(payload),
  ts,
});

try {
  const {
    mapHookEventToRow,
    mapActivityLineToRow,
    parseActivityTimestamp,
    buildTimeline,
    clampLimit,
    TIMELINE_LIMIT_DEFAULT,
    TIMELINE_LIMIT_MAX,
  } = await import("../src/timeline/index.ts");

  // --- mapHookEventToRow: each documented subtype --------------------------
  const prompt = mapHookEventToRow(
    hookEv("UserPromptSubmit", { prompt: "Add a Claude-banner session header above the terminal" }, 1000),
  );
  check(
    "UserPromptSubmit → kind:hook subtype:PROMPT, title carries (truncated) prompt",
    prompt?.kind === "hook" &&
      prompt.subtype === "PROMPT" &&
      typeof prompt.title === "string" &&
      prompt.title.length > 0 &&
      prompt.title.startsWith("Add a Claude-banner"),
  );

  const longPrompt = mapHookEventToRow(
    hookEv("UserPromptSubmit", { prompt: "x".repeat(500) }, 1100),
  );
  check(
    "long prompt is truncated with an ellipsis",
    longPrompt?.kind === "hook" &&
      longPrompt.title.length <= 161 &&
      longPrompt.title.endsWith("…"),
  );

  const emptyPrompt = mapHookEventToRow(
    hookEv("UserPromptSubmit", { prompt: "" }, 1150),
  );
  check(
    "empty prompt → '(empty prompt)' title, never fabricated content",
    emptyPrompt?.kind === "hook" && emptyPrompt.title === "(empty prompt)",
  );

  const preTool = mapHookEventToRow(
    hookEv(
      "PreToolUse",
      { tool_input: { command: "npm test", description: "run tests" } },
      1200,
      "Bash",
    ),
  );
  check(
    "PreToolUse → subtype:PRETOOL, title = '<tool> · <first string arg>'",
    preTool?.kind === "hook" &&
      preTool.subtype === "PRETOOL" &&
      preTool.title === "Bash · npm test",
  );

  const postTool = mapHookEventToRow(
    hookEv(
      "PostToolUse",
      { tool_input: { file_path: "/x/y.ts" } },
      1300,
      "Read",
    ),
  );
  check(
    "PostToolUse → subtype:POSTTOOL, title = '<tool> · <first string arg>'",
    postTool?.kind === "hook" &&
      postTool.subtype === "POSTTOOL" &&
      postTool.title === "Read · /x/y.ts",
  );

  const stop = mapHookEventToRow(hookEv("Stop", {}, 1400));
  check(
    "Stop → subtype:STOP, fixed 'turn ended' title",
    stop?.kind === "hook" && stop.subtype === "STOP" && stop.title === "turn ended",
  );

  const notif = mapHookEventToRow(
    hookEv("Notification", { message: "Claude wants permission to run Bash" }, 1500),
  );
  check(
    "Notification → subtype:NOTIF, title from message",
    notif?.kind === "hook" &&
      notif.subtype === "NOTIF" &&
      notif.title === "Claude wants permission to run Bash",
  );

  const sessionStart = mapHookEventToRow(
    hookEv(
      "SessionStart",
      { source: "startup", version: "2.1.152" },
      1600,
    ),
  );
  check(
    "SessionStart → subtype:SESSION, detail carries source + v<version>",
    sessionStart?.kind === "hook" &&
      sessionStart.subtype === "SESSION" &&
      sessionStart.title === "SessionStart" &&
      sessionStart.detail === "startup · v2.1.152",
  );

  const sessionEnd = mapHookEventToRow(
    hookEv("SessionEnd", { reason: "exit" }, 1700),
  );
  check(
    "SessionEnd → subtype:SESSION, detail carries reason",
    sessionEnd?.kind === "hook" &&
      sessionEnd.subtype === "SESSION" &&
      sessionEnd.title === "SessionEnd" &&
      sessionEnd.detail === "exit",
  );

  const unknown = mapHookEventToRow(hookEv("CustomHook", {}, 1800));
  check(
    "unknown hook → subtype:EVENT (never null), title = hook name",
    unknown?.kind === "hook" && unknown.subtype === "EVENT" && unknown.title === "CustomHook",
  );

  // Non-hook stream_type (e.g. legacy stream_event) is not part of the
  // Timeline envelope — explicitly null.
  const notHook = mapHookEventToRow({
    id: 999,
    session_id: "s",
    parent_tool_use_id: null,
    hook_event_name: "Stop",
    stream_type: "stream_event",
    tool_name: null,
    payload: "{}",
    ts: 1900,
  });
  check("non-hook stream_type → null (skipped)", notHook === null);

  // Malformed payload doesn't throw; the row still maps with sensible defaults.
  const malformed = mapHookEventToRow({
    id: 1000,
    session_id: "s",
    parent_tool_use_id: null,
    hook_event_name: "UserPromptSubmit",
    stream_type: "hook",
    tool_name: null,
    payload: "{not json",
    ts: 2000,
  });
  check(
    "malformed payload doesn't throw, falls back gracefully",
    malformed?.kind === "hook" && malformed.subtype === "PROMPT",
  );

  // --- parseActivityTimestamp ----------------------------------------------
  check(
    "bracketed timestamp w/ seconds parses",
    parseActivityTimestamp("[2026-05-27 13:46:06] iteration 10 → US-010") ===
      Date.parse("2026-05-27T13:46:06"),
  );
  check(
    "bare timestamp w/ minutes parses (00 seconds assumed)",
    parseActivityTimestamp("2026-05-27 14:20 US-010 done") ===
      Date.parse("2026-05-27T14:20:00"),
  );
  check("garbage line → null timestamp", parseActivityTimestamp("nothing here") === null);

  // --- mapActivityLineToRow: each loop subtype -----------------------------
  const iter = mapActivityLineToRow("[2026-05-27 13:46:06] iteration 10 → US-010: Bottom status bar");
  check(
    "iteration line → subtype:iteration",
    iter?.kind === "loop" && iter.subtype === "iteration" &&
      iter.title.startsWith("iteration 10"),
  );

  const passRow = mapActivityLineToRow("2026-05-27 14:20 US-010 done: bottom status bar shipped");
  check(
    "'<US-N> done' line → subtype:pass",
    passRow?.kind === "loop" && passRow.subtype === "pass",
  );

  const trail = mapActivityLineToRow(
    "[2026-05-27 13:48:40] ⏳ usage limit — resumes in 1279s",
  );
  check(
    "freeform trail line → subtype:trail",
    trail?.kind === "loop" && trail.subtype === "trail",
  );

  check(
    "activity line w/o leading ts → null (no fabricated ts)",
    mapActivityLineToRow("US-010: no timestamp here") === null,
  );

  // --- clampLimit ----------------------------------------------------------
  check("clampLimit(undefined) → default", clampLimit(undefined) === TIMELINE_LIMIT_DEFAULT);
  check("clampLimit(0) → 1 (floor)", clampLimit(0) === 1);
  check("clampLimit(-5) → 1 (floor)", clampLimit(-5) === 1);
  check("clampLimit(99999) → MAX", clampLimit(99999) === TIMELINE_LIMIT_MAX);
  check("clampLimit(50) → 50", clampLimit(50) === 50);
  check("clampLimit(NaN) → default", clampLimit(NaN) === TIMELINE_LIMIT_DEFAULT);

  // --- buildTimeline: ordering, since, limit, cwd-gate ---------------------
  // Use realistic epoch-ms timestamps so the hook ts axis is comparable to the
  // ts parser pulls off the activity lines (both are real epoch ms).
  const T_PROMPT = Date.parse("2026-05-27T13:00:00");
  const T_PRETOOL = Date.parse("2026-05-27T13:01:00");
  const T_STOP = Date.parse("2026-05-27T13:30:00"); // newest of all 5 rows
  const events = [
    hookEv("UserPromptSubmit", { prompt: "hi" }, T_PROMPT),
    hookEv("PreToolUse", { tool_input: { command: "ls" } }, T_PRETOOL, "Bash"),
    hookEv("Stop", {}, T_STOP),
  ];
  const activity = [
    "[2026-05-27 12:00:00] iteration 1 → US-001",
    "2026-05-27 12:05 US-001 done: timeline route",
  ];

  const merged = buildTimeline({
    events,
    activity,
    sessionCwd: "/p",
    activeCwd: "/p",
  });
  check("merged result includes hook + loop rows", merged.length === 5);
  check(
    "descending ts ordering",
    merged[0].ts >= merged[1].ts && merged[1].ts >= merged[2].ts,
  );
  check(
    "first row is the newest hook (Stop)",
    merged[0].kind === "hook" && merged[0].subtype === "STOP",
  );

  const noLoop = buildTimeline({
    events,
    activity,
    sessionCwd: "/other",
    activeCwd: "/p",
  });
  check(
    "session in a different cwd → no loop rows",
    noLoop.length === 3 && noLoop.every((r) => r.kind === "hook"),
  );

  const nullCwd = buildTimeline({
    events,
    activity,
    sessionCwd: null,
    activeCwd: "/p",
  });
  check("session w/ null cwd → no loop rows", nullCwd.every((r) => r.kind === "hook"));

  const sinceFilter = buildTimeline({
    events,
    activity: [],
    sessionCwd: "/p",
    activeCwd: "/p",
    since: T_PRETOOL, // strictly greater than → excludes the PRETOOL ts itself
  });
  check(
    "since strictly excludes equal ts (only Stop remains)",
    sinceFilter.length === 1 && sinceFilter[0].ts === T_STOP,
  );

  const limited = buildTimeline({
    events,
    activity: [],
    sessionCwd: "/p",
    activeCwd: "/p",
    limit: 2,
  });
  check("limit=2 truncates after sort", limited.length === 2);

  const empty = buildTimeline({
    events: [],
    activity: [],
    sessionCwd: "/p",
    activeCwd: "/p",
  });
  check("empty inputs → empty array", empty.length === 0);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

// --- integration: real gateway on the isolated DB set up at the top ------
// We don't assert loop rows here — keeping the test focused on hook-row
// envelope behavior. (Loop-row mapping is covered by the pure unit tests
// above; the route's loop-merge path is exercised in US-004's UI verify.)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Consume the response body so the next post waits for the insert to commit.
const post = async (body) => {
  const r = await fetch(`${BASE}/api/claude/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify(body),
  });
  return r.json();
};

try {
  await import("../src/gateway/index.ts");
  await sleep(300);

  // --- auth gate -----------------------------------------------------------
  const unauthed = await fetch(`${BASE}/api/claude/timeline?session=anything`);
  check("GET /timeline requires the token (401 unauthed)", unauthed.status === 401);

  // --- unknown session → empty array (never 404, never throws) -------------
  const unknownRes = await fetch(`${BASE}/api/claude/timeline?session=does-not-exist`, {
    headers: { "x-conan-token": TOKEN },
  });
  const unknown = await unknownRes.json();
  check(
    "unknown session → empty array, 200",
    unknownRes.status === 200 && Array.isArray(unknown) && unknown.length === 0,
  );

  // Missing session param → empty array too.
  const missingRes = await fetch(`${BASE}/api/claude/timeline`, {
    headers: { "x-conan-token": TOKEN },
  });
  const missing = await missingRes.json();
  check(
    "missing session param → empty array",
    missingRes.status === 200 && Array.isArray(missing) && missing.length === 0,
  );

  // --- post a real session w/ one of each documented hook subtype ---------
  const SID = "tl-real";
  await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "SessionStart",
    payload: { session_id: SID, hook_event_name: "SessionStart", version: "2.1.152", source: "startup" },
  });
  await sleep(20);
  await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "UserPromptSubmit",
    payload: { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "Hello timeline" },
  });
  await sleep(20);
  await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    payload: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } },
  });
  await sleep(20);
  await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    payload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } },
  });
  await sleep(20);
  await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "Stop",
    payload: { session_id: SID, hook_event_name: "Stop" },
  });
  await sleep(50);

  const rows = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check("real session returns the 5 posted rows", Array.isArray(rows) && rows.length === 5);
  check(
    "rows are descending by ts (newest first — Stop)",
    rows[0]?.subtype === "STOP" && rows[rows.length - 1]?.subtype === "SESSION",
  );
  check(
    "every returned row carries the discriminated-union shape",
    rows.every(
      (r) =>
        r.kind === "hook" &&
        typeof r.ts === "number" &&
        typeof r.eventId === "number" &&
        typeof r.subtype === "string" &&
        typeof r.title === "string",
    ),
  );

  // --- since filter --------------------------------------------------------
  // Cut at the PRETOOL row's ts. since is strict greater-than → excludes that
  // row and everything older. Of 5, only POSTTOOL + STOP remain (2).
  const pretool = rows.find((r) => r.subtype === "PRETOOL");
  const sinceRows = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}&since=${pretool.ts}`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check(
    "since=PRETOOL.ts strictly excludes that row + everything older",
    sinceRows.length === 2 &&
      sinceRows.every((r) => r.ts > pretool.ts) &&
      sinceRows.some((r) => r.subtype === "STOP"),
  );

  // --- limit clamp --------------------------------------------------------
  const cappedRows = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}&limit=2`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check("limit=2 returns at most 2 (newest first)", cappedRows.length === 2);

  // limit=99999 clamps to the documented max (500); we only have 5 rows here
  // but the route must not crash on an absurd value.
  const hugeLimit = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}&limit=99999`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check("limit=99999 doesn't crash; returns all 5 (clamped)", hugeLimit.length === 5);

  // limit=0 → clamps up to 1; route must still respond.
  const zeroLimit = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}&limit=0`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check("limit=0 floors to 1 row (the newest STOP)", zeroLimit.length === 1 && zeroLimit[0].subtype === "STOP");
} catch (err) {
  console.log("FAIL - threw (integration):", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
