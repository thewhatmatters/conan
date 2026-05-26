// US-014 test: subagent reconstruction — rebuild a session's subagent tree from
// ~/.claude/projects/<enc-cwd>/<session-id>/subagents/{agent-<id>.jsonl,.meta.json}
// for ANY session (not just live ones).
// Exercises the pure module against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR), then the gateway route end-to-end:
//   - parses agent-*.meta.json {agentType, description, toolUseId} + transcript
//   - assembles a tree: subagent spawned by the main transcript = root; one
//     spawned by another subagent's transcript nests under it
//   - resolves the session folder without a known cwd (scan fallback)
//   - sessions with no subagents / missing project dir → safe found:false shape
//
// Run: tsx scripts/test-subagents.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-subagents-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const projectsDir = path.join(claudeDir, "projects");
fs.mkdirSync(projectsDir, { recursive: true });

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

// --- seed a project with one session that has nested subagents --------------
// Encoded cwd folder (Claude Code replaces / and . with -).
const cwd = "/Users/me/Development/demo";
const encCwd = cwd.replace(/[/.]/g, "-");
const projDir = path.join(projectsDir, encCwd);
const sessionId = "11111111-2222-3333-4444-555555555555";
const sessionDir = path.join(projDir, sessionId);
const subDir = path.join(sessionDir, "subagents");
fs.mkdirSync(subDir, { recursive: true });

const assistantToolUse = (id, name) =>
  JSON.stringify({
    type: "assistant",
    uuid: `u-${id}`,
    timestamp: "2026-05-26T10:00:00.000Z",
    message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "tool_use", id, name, input: {} }] },
  });
const userText = (text, ts) =>
  JSON.stringify({
    type: "user",
    uuid: `uu-${ts}`,
    timestamp: ts,
    message: { role: "user", content: text },
  });

// Main session transcript: spawns subagent A via Task tool_use id TU_A.
fs.writeFileSync(
  `${sessionDir}.jsonl`,
  [userText("do the thing", "2026-05-26T09:59:00.000Z"), assistantToolUse("toolu_TU_A", "Task")].join("\n") + "\n",
);

// Subagent A: its meta points at TU_A (found in the MAIN transcript → root).
// A itself spawns subagent B via a nested Task tool_use id TU_B.
const idA = "aaaa111";
fs.writeFileSync(
  path.join(subDir, `agent-${idA}.meta.json`),
  JSON.stringify({ agentType: "Explore", description: "find the file", toolUseId: "toolu_TU_A" }),
);
fs.writeFileSync(
  path.join(subDir, `agent-${idA}.jsonl`),
  [
    userText("A: please explore", "2026-05-26T10:00:01.000Z"),
    assistantToolUse("toolu_TU_B", "Task"),
  ].join("\n") + "\n",
);

// Subagent B: its meta points at TU_B (found in A's transcript → nests under A).
const idB = "bbbb222";
fs.writeFileSync(
  path.join(subDir, `agent-${idB}.meta.json`),
  JSON.stringify({ agentType: "general-purpose", description: "deep dive", toolUseId: "toolu_TU_B" }),
);
fs.writeFileSync(
  path.join(subDir, `agent-${idB}.jsonl`),
  userText("B: working", "2026-05-26T10:00:02.000Z") + "\n",
);

// A second session with an empty subagents dir → found:true, no subagents.
const emptySession = "99999999-0000-0000-0000-000000000000";
fs.mkdirSync(path.join(projDir, emptySession, "subagents"), { recursive: true });

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/subagents/index.ts");

  // Resolve WITHOUT a known cwd (scan fallback).
  const out = mod.readSubagents(sessionId);
  check("found subagents for the session via scan (no cwd)", out.found === true);
  check("one root subagent (A spawned by main transcript)", out.subagents.length === 1);

  const a = out.subagents[0];
  check("root is subagent A", a && a.agentId === idA);
  check("A meta parsed (agentType/description/toolUseId)", Boolean(
    a && a.agentType === "Explore" && a.description === "find the file" && a.toolUseId === "toolu_TU_A",
  ));
  check("A carries its own transcript", a && a.transcript.length >= 1);
  check("B nests under A (spawned by A's transcript)", a && a.children.length === 1 && a.children[0].agentId === idB);
  check("B meta parsed", a && a.children[0].toolUseId === "toolu_TU_B" && a.children[0].agentType === "general-purpose");

  // Resolve WITH the known cwd (direct path).
  const direct = mod.readSubagents(sessionId, cwd);
  check("resolves with known cwd too", direct.found === true && direct.subagents.length === 1);

  // Empty subagents dir → found, but no subagents.
  const empty = mod.readSubagents(emptySession);
  check("empty subagents dir → found:true, []", empty.found === true && empty.subagents.length === 0);

  // Unknown session → safe shape.
  const none = mod.readSubagents("no-such-session-id");
  check("unknown session → found:false, []", none.found === false && none.subagents.length === 0);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/sessions/${sessionId}/subagents`)).json();
  check("GET subagents returns the tree", g.found === true && g.subagents.length === 1);
  check("GET tree nests B under A", g.subagents[0].children.length === 1 && g.subagents[0].children[0].agentId === idB);

  const gNone = await (await fetch(`${BASE}/api/claude/sessions/no-such/subagents`)).json();
  check("GET unknown session → safe empty shape", gNone.found === false && Array.isArray(gNone.subagents));
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
