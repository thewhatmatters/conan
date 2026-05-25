// US-021 browser-verification harness: boot the REAL gateway (serving the built
// UI) and seed — via the hook-ingest route — a session whose events include a
// parent Task tool-use plus nested subagent child events (carrying
// parent_tool_use_id, agent_id, transcript_path). Leaves the gateway running so
// automate-browser can confirm the timeline nests + collapses the subagent node
// and shows its agent_id + transcript link.
//
// Run: tsx scripts/verify-subagents.mjs   (Ctrl-C to stop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-subagents-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "verify-token";
const PORT = 3769;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = "sess-subagent-tree";
const TRANSCRIPT = "/Users/you/.claude/projects/-Users-you-conan/agent-7f3a2c.jsonl";

let ts = Date.now() - 60_000;
async function ev(body) {
  ts += 1500;
  await fetch(BASE + "/api/claude/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ session_id: SID, cwd: tmp, ...body }),
  });
}

await import("../src/gateway/index.ts");
await sleep(400);

// Top-level: prompt -> Task tool-use (tool_use_id "task-1") that spawns a subagent.
await ev({ hook_event_name: "UserPromptSubmit", payload: { prompt: "Review the diff with a subagent" } });
await ev({
  hook_event_name: "PreToolUse",
  tool_name: "Task",
  payload: { tool_use_id: "task-1", tool_input: { subagent_type: "code-reviewer", description: "review the diff" } },
});

// Nested subagent events: parent_tool_use_id = "task-1".
const sub = { parent_tool_use_id: "task-1" };
await ev({ ...sub, hook_event_name: "SubagentStart", payload: { agent_id: "agent-7f3a2c", subagent_type: "code-reviewer", transcript_path: TRANSCRIPT } });
await ev({ ...sub, hook_event_name: "PreToolUse", tool_name: "Read", payload: { tool_input: { file_path: "/Users/you/conan/src/db/index.ts" }, transcript_path: TRANSCRIPT } });
await ev({ ...sub, hook_event_name: "PostToolUse", tool_name: "Read", payload: { tool_input: { file_path: "/Users/you/conan/src/db/index.ts" } } });
await ev({ ...sub, hook_event_name: "PreToolUse", tool_name: "Grep", payload: { tool_input: { pattern: "PRAGMA journal_mode" } } });
await ev({ ...sub, hook_event_name: "SubagentStop", payload: { agent_id: "agent-7f3a2c", transcript_path: TRANSCRIPT } });

// Top-level: Task tool completes, then the main agent stops.
await ev({ hook_event_name: "PostToolUse", tool_name: "Task", payload: { tool_use_id: "task-1", tool_response: "review complete" } });
await ev({ hook_event_name: "Stop", payload: {} });

await sleep(300);
const rows = await (await fetch(`${BASE}/api/claude/sessions/${SID}/events`)).json();
console.log(`\n[verify] seeded ${rows.length} events for ${SID}`);
const nested = rows.filter((r) => r.parent_tool_use_id === "task-1");
console.log(`[verify] ${nested.length} nested under task-1:`, nested.map((r) => r.hook_event_name).join(", "));
console.log(`\n[verify] gateway live on ${BASE} (token=${TOKEN}). Open and select "${SID}". Ctrl-C to stop.`);

process.on("SIGINT", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
