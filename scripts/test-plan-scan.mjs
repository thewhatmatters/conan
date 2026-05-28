// US-006 (v4.5) test: the transcript scanner's plan-extension
// (extractPlanBlocks + readSessionPlans in src/timeline/transcriptScan.ts) +
// the live JSONL watcher emitting `{type:'plan'}` WS broadcasts for new
// TodoWrite / ExitPlanMode tool_use blocks.
//
// Unit half: extractPlanBlocks on a real-shape JSONL fixture with one
// TodoWrite + one ExitPlanMode block; asserts shapes (items[] with statuses
// for TodoWrite, plan string for ExitPlanMode); the empty case (a transcript
// with NO plan blocks → []).
//
// Integration half: boot the gateway on an isolated DB, post a UserPromptSubmit
// hook event referencing a fixture transcript JSONL, then append a TodoWrite
// block to the watched JSONL and assert a `{type:'plan'}` WS frame arrives with
// the expected payload.
//
// CRITICAL: CONAN_DATA_DIR + HOME are read at module-import time (paths.ts) so
// we set both BEFORE importing any src/* module.
//
// Run: tsx scripts/test-plan-scan.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-plan-scan-"));
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.HOME = tmp;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- shared fixture ---------------------------------------------------------
// Mirrors a real Claude Code JSONL: one TodoWrite tool_use + one ExitPlanMode
// tool_use on assistant lines, each carrying a real `timestamp`. Surrounding
// noise lines (user text, malformed JSON, a non-plan tool_use) must be ignored.
const TS_TODO = "2026-05-28T10:00:00.000Z";
const TS_PLAN = "2026-05-28T10:05:00.000Z";
const TODO_ITEMS = [
  { content: "Wire the watcher", status: "completed", activeForm: "Wiring the watcher" },
  { content: "Add the scanner", status: "in_progress", activeForm: "Adding the scanner" },
  { content: "Write the tests", status: "pending", activeForm: "Writing the tests" },
];
const PLAN_TEXT =
  "## Plan\n1. Extract TodoWrite + ExitPlanMode\n2. Emit plan WS broadcast\n3. Ship US-006";

const fixtureLine = (o) => JSON.stringify(o);
const fixtureJsonl = [
  fixtureLine({
    type: "user",
    timestamp: "2026-05-28T09:59:00.000Z",
    message: { role: "user", content: "plan it out" },
  }),
  fixtureLine({
    type: "assistant",
    timestamp: TS_TODO,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_todo",
          name: "TodoWrite",
          input: { todos: TODO_ITEMS },
        },
      ],
    },
  }),
  fixtureLine({
    type: "assistant",
    timestamp: TS_PLAN,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Here's the plan." },
        {
          type: "tool_use",
          id: "toolu_plan",
          name: "ExitPlanMode",
          input: { plan: PLAN_TEXT },
        },
      ],
    },
  }),
  // Non-plan tool_use — must be ignored by the plan extractor.
  fixtureLine({
    type: "assistant",
    timestamp: "2026-05-28T10:06:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } },
      ],
    },
  }),
  // Malformed JSON — skipped.
  "{not valid json",
  // Empty line.
  "",
].join("\n");

// --- Unit: extractPlanBlocks ------------------------------------------------
try {
  const {
    extractPlanBlocks,
    readTranscriptPlans,
    readSessionPlans,
  } = await import("../src/timeline/transcriptScan.ts");

  const recs = extractPlanBlocks(fixtureJsonl);
  check(
    "extracts both plan blocks from a real-shape JSONL (TodoWrite + ExitPlanMode)",
    recs.length === 2,
  );
  const todo = recs.find((r) => r.subtype === "todo-write");
  const plan = recs.find((r) => r.subtype === "plan-mode");
  check(
    "TodoWrite block: subtype=todo-write, ts=epoch ms of assistant timestamp",
    todo && todo.ts === Date.parse(TS_TODO),
  );
  check(
    "TodoWrite block carries items[] with content + status (statuses preserved)",
    todo &&
      Array.isArray(todo.items) &&
      todo.items.length === 3 &&
      todo.items[0].content === "Wire the watcher" &&
      todo.items[0].status === "completed" &&
      todo.items[1].status === "in_progress" &&
      todo.items[2].status === "pending",
  );
  check(
    "TodoWrite items carry activeForm when present",
    todo &&
      todo.items[0].activeForm === "Wiring the watcher" &&
      todo.items[1].activeForm === "Adding the scanner",
  );
  check(
    "ExitPlanMode block: subtype=plan-mode, ts=epoch ms, plan string preserved verbatim",
    plan &&
      plan.ts === Date.parse(TS_PLAN) &&
      plan.plan === PLAN_TEXT,
  );

  // Non-plan tool_use (Bash) and malformed JSON must not surface as plan rows.
  check(
    "non-plan tool_use is not in the output",
    !recs.some((r) => r.subtype !== "todo-write" && r.subtype !== "plan-mode"),
  );

  // The empty case (acceptance criterion): a fixture with NO plan blocks → [].
  const noPlanJsonl = [
    fixtureLine({
      type: "user",
      timestamp: "2026-05-28T11:00:00.000Z",
      message: { role: "user", content: "hi" },
    }),
    fixtureLine({
      type: "assistant",
      timestamp: "2026-05-28T11:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello." }],
      },
    }),
  ].join("\n");
  const none = extractPlanBlocks(noPlanJsonl);
  check(
    "transcript without any TodoWrite/ExitPlanMode → []",
    Array.isArray(none) && none.length === 0,
  );

  // Bad statuses + missing content are skipped — never fabricated.
  const partialTodo = fixtureLine({
    type: "assistant",
    timestamp: "2026-05-28T11:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "", status: "pending" }, // dropped — empty content
              { content: "ok", status: "nonsense" }, // dropped — bad status
              { content: "real", status: "completed" }, // kept
            ],
          },
        },
      ],
    },
  });
  const partial = extractPlanBlocks(partialTodo);
  check(
    "TodoWrite items with bad/empty fields are skipped (kept item: 'real')",
    partial.length === 1 &&
      partial[0].subtype === "todo-write" &&
      partial[0].items.length === 1 &&
      partial[0].items[0].content === "real",
  );

  // ExitPlanMode with non-string plan is skipped.
  const badPlan = fixtureLine({
    type: "assistant",
    timestamp: "2026-05-28T11:00:03.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "ExitPlanMode", input: { plan: 42 } },
      ],
    },
  });
  check(
    "ExitPlanMode with non-string plan is skipped",
    extractPlanBlocks(badPlan).length === 0,
  );

  // ExitPlanMode with empty plan is skipped.
  const emptyPlan = fixtureLine({
    type: "assistant",
    timestamp: "2026-05-28T11:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "" } }],
    },
  });
  check(
    "ExitPlanMode with empty plan string is skipped",
    extractPlanBlocks(emptyPlan).length === 0,
  );

  // Unparseable timestamp → skipped (never fabricated).
  const badTs = fixtureLine({
    type: "assistant",
    timestamp: "not-a-date",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "TodoWrite", input: { todos: TODO_ITEMS } },
      ],
    },
  });
  check(
    "plan block with unparseable timestamp is skipped (no fabricated ts)",
    extractPlanBlocks(badTs).length === 0,
  );

  // readTranscriptPlans reads from disk.
  const tmpFile = path.join(tmp, "fixture.jsonl");
  fs.writeFileSync(tmpFile, fixtureJsonl);
  const onDisk = readTranscriptPlans(tmpFile);
  check("readTranscriptPlans reads disk + parses (2 plan blocks)", onDisk.length === 2);
  check(
    "readTranscriptPlans on a missing file → [] (never throws)",
    readTranscriptPlans(path.join(tmp, "does-not-exist.jsonl")).length === 0,
  );

  // readSessionPlans via the canonical transcriptPath resolver.
  const sid = "plan-fixture-sid";
  const encodedCwd = tmp.replace(/[/.]/g, "-");
  const projectDir = path.join(tmp, ".claude", "projects", encodedCwd);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), fixtureJsonl);
  const viaResolver = readSessionPlans(sid, tmp);
  check(
    "readSessionPlans resolves via transcriptPath() and parses both blocks",
    viaResolver.length === 2,
  );
} catch (err) {
  console.log("FAIL - threw (unit):", err?.stack ?? err?.message ?? err);
  failed = true;
}

// --- Integration: live watcher → {type:'plan'} broadcast --------------------
try {
  // Stage a transcript JSONL the watcher can tail. We seed it with a single
  // user line so it exists with a known initial size, then append the
  // TodoWrite block mid-watch.
  const SID = "plan-watch-sid";
  const encodedCwd = tmp.replace(/[/.]/g, "-");
  const projectDir = path.join(tmp, ".claude", "projects", encodedCwd);
  fs.mkdirSync(projectDir, { recursive: true });
  const jsonlPath = path.join(projectDir, `${SID}.jsonl`);
  fs.writeFileSync(
    jsonlPath,
    JSON.stringify({
      type: "user",
      timestamp: "2026-05-28T11:59:00.000Z",
      message: { role: "user", content: "stage the watcher" },
    }) + "\n",
  );

  // Boot the gateway (after CONAN_DATA_DIR/HOME are frozen above).
  await import("../src/gateway/index.ts");
  await sleep(300);

  // Open the app WS and collect frames.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const FRAMES = [];
  ws.on("message", (d) => {
    try {
      FRAMES.push(JSON.parse(d.toString()));
    } catch {
      /* ignore */
    }
  });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  await sleep(100);

  const post = async (body) => {
    const r = await fetch(`${BASE}/api/claude/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": TOKEN },
      body: JSON.stringify(body),
    });
    return r.json();
  };

  // Submit a UserPromptSubmit hook that names the transcript path so the
  // gateway sets up the watcher on our fixture JSONL.
  const promptRes = await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "UserPromptSubmit",
    payload: {
      session_id: SID,
      hook_event_name: "UserPromptSubmit",
      transcript_path: jsonlPath,
      prompt: "stage the watcher",
    },
  });
  check("UserPromptSubmit ingest returns {ok:true}", promptRes?.ok === true);
  const promptEventId = promptRes?.id;
  check("ingest returns persisted event id", typeof promptEventId === "number");
  await sleep(150); // let the watcher attach + emit any backfill

  FRAMES.length = 0; // clear pre-append noise

  // Now append a TodoWrite tool_use block to the JSONL — the watcher must
  // see the size change and emit a {type:'plan'} broadcast.
  const appendTs = new Date().toISOString();
  const appendItems = [
    { content: "ship US-006", status: "in_progress", activeForm: "Shipping US-006" },
    { content: "celebrate", status: "pending", activeForm: "Celebrating" },
  ];
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({
      type: "assistant",
      timestamp: appendTs,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_live",
            name: "TodoWrite",
            input: { todos: appendItems },
          },
        ],
      },
    }) + "\n",
  );

  // Wait for fs.watch + tail to fire. fs.watch on macOS can take a beat.
  let planFrames = [];
  for (let i = 0; i < 30 && planFrames.length === 0; i++) {
    await sleep(100);
    planFrames = FRAMES.filter((f) => f?.type === "plan");
  }
  check("≥1 {type:'plan'} WS frame arrived after the append", planFrames.length >= 1);
  const todoFrame = planFrames.find(
    (f) => f.payload?.subtype === "todo-write",
  );
  check(
    "plan frame is todo-write with the appended items + the prompt's event id",
    todoFrame &&
      todoFrame.sessionId === SID &&
      todoFrame.payload?.kind === "plan" &&
      todoFrame.payload?.ts === Date.parse(appendTs) &&
      Array.isArray(todoFrame.payload?.items) &&
      todoFrame.payload.items.length === 2 &&
      todoFrame.payload.items[0].content === "ship US-006" &&
      todoFrame.payload.items[0].status === "in_progress" &&
      todoFrame.payload.promptEventId === promptEventId,
  );

  // Append an ExitPlanMode block now and assert a second {type:'plan'} frame
  // with subtype=plan-mode arrives carrying the plan string verbatim.
  FRAMES.length = 0;
  const planTs = new Date(Date.now() + 1000).toISOString();
  const livePlanText = "## Live Plan\n- step one\n- step two";
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({
      type: "assistant",
      timestamp: planTs,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_live_plan",
            name: "ExitPlanMode",
            input: { plan: livePlanText },
          },
        ],
      },
    }) + "\n",
  );
  let planModeFrames = [];
  for (let i = 0; i < 30 && planModeFrames.length === 0; i++) {
    await sleep(100);
    planModeFrames = FRAMES.filter(
      (f) => f?.type === "plan" && f.payload?.subtype === "plan-mode",
    );
  }
  check(
    "subsequent ExitPlanMode append broadcasts {type:'plan', subtype:'plan-mode'}",
    planModeFrames.length >= 1 &&
      planModeFrames[0].payload?.plan === livePlanText &&
      planModeFrames[0].sessionId === SID,
  );

  // Both blocks must also surface from the Timeline read route as `kind:'plan'`
  // rows (the read-path merges readSessionPlans into buildTimeline).
  const tlRows = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  const planRows = tlRows.filter((r) => r.kind === "plan");
  check("GET /timeline returns ≥2 plan rows for the session", planRows.length >= 2);
  check(
    "timeline plan rows carry the expected subtype mix",
    planRows.some((r) => r.subtype === "todo-write") &&
      planRows.some((r) => r.subtype === "plan-mode"),
  );

  ws.close();
} catch (err) {
  console.log("FAIL - threw (integration):", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
