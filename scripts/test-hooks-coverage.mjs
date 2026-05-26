// US-009 test: hooks-coverage — Conan's hook consumption vs Claude Code's FULL
// hook-event set, wired/unwired per scope (user + project).
// Exercises the pure module against a hermetic fake ~/.claude + project dir,
// then the gateway route end-to-end:
//   - full set sourced from the bundled canonical schema (superset of consumed)
//   - each event marked consumedByConan (the nine) + wired per scope
//   - events Conan can't consume yet (SubagentStart, PermissionRequest) flagged
//   - reads both settings.json + settings.local.json per scope; absence is safe
//
// Run: tsx scripts/test-hooks-coverage.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-hookscov-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const projectDir = path.join(tmp, "project");
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });

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

const hookBlock = (events) => ({
  hooks: Object.fromEntries(
    events.map((e) => [e, [{ hooks: [{ type: "command", command: "node send-event.mjs" }] }]]),
  ),
});

// User scope wires SessionStart (in settings.json) + Stop (in settings.local.json).
fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(hookBlock(["SessionStart"])));
fs.writeFileSync(
  path.join(claudeDir, "settings.local.json"),
  JSON.stringify(hookBlock(["Stop"])),
);
// Project scope wires PreToolUse + an empty SubagentStart array (must NOT count).
const projSettings = hookBlock(["PreToolUse"]);
projSettings.hooks.SubagentStart = []; // empty → unwired
fs.writeFileSync(path.join(projectDir, ".claude", "settings.json"), JSON.stringify(projSettings));

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/hooks-coverage/index.ts");
  const out = mod.readHooksCoverage({ projectDir });

  check("full set is a superset of consumed (>= 9)", out.events.length >= 9);
  check("consumed list has the nine Conan ingests", out.consumed.length === 9);
  check(
    "summary counts are coherent",
    out.summary.total === out.events.length &&
      out.summary.consumed === 9 &&
      out.summary.unconsumed === out.summary.total - 9,
  );

  const byName = Object.fromEntries(out.events.map((e) => [e.event, e]));

  check("SessionStart consumed + wired in user scope", Boolean(
    byName.SessionStart?.consumedByConan && byName.SessionStart.wired.user,
  ));
  check("Stop wired via user settings.local.json", Boolean(byName.Stop?.wired.user));
  check("PreToolUse wired in project scope (not user)", Boolean(
    byName.PreToolUse?.wired.project && !byName.PreToolUse.wired.user,
  ));
  check("PreToolUse NOT wired in user scope", byName.PreToolUse?.wired.user === false);

  // events Conan can't consume yet are present + flagged
  check("SubagentStart present + not consumed", Boolean(
    byName.SubagentStart && byName.SubagentStart.consumedByConan === false,
  ));
  check("PermissionRequest present + not consumed", Boolean(
    byName.PermissionRequest && byName.PermissionRequest.consumedByConan === false,
  ));
  check("empty hook array does NOT count as wired", byName.SubagentStart?.wired.project === false);

  check("wiredUser counts both files (SessionStart + Stop)", out.summary.wiredUser === 2);
  check("wiredProject counts one (PreToolUse)", out.summary.wiredProject === 1);
  check("scopes report the files read per scope", Boolean(
    out.scopes.user?.length === 2 && out.scopes.project?.length === 2,
  ));

  // --- absence is safe ----------------------------------------------------
  const bare = mod.readHooksCoverage({ projectDir: path.join(tmp, "nonexistent") });
  check("missing project settings → no project wiring, no throw", bare.summary.wiredProject === 0);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/hooks-coverage`)).json();
  check("GET /api/claude/hooks-coverage returns events", Array.isArray(g.events) && g.events.length >= 9);
  check("GET payload carries consumed + summary", Array.isArray(g.consumed) && typeof g.summary?.total === "number");
  const gStart = g.events.find((e) => e.event === "SessionStart");
  check("GET SessionStart wired in user scope", Boolean(gStart?.wired?.user));
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
