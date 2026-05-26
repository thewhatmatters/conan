// US-013 test: background agents — shell out to `claude agents --json` and
// return the parsed live background-agent list, normalized to a stable shape.
//
// The real CLI needs a logged-in claude + live sessions, so the shell-out is
// pointed at a hermetic fake `claude` binary via CONAN_CLAUDE_BIN. Exercises:
//   - the pure normalizeAgents() over the confirmed { pid, cwd, kind, startedAt,
//     sessionId, status? } shape (newest-first; absent status → null)
//   - readBackgroundAgents() against a fake that prints a JSON array
//   - --cwd filter passed through to the CLI
//   - non-zero exit / non-array output / missing binary → available:false, []
//   - the gateway route is token-gated and returns the payload
//
// Run: tsx scripts/test-background-agents.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-bgagents-test-"));
const dataDir = path.join(tmp, "data");
fs.mkdirSync(dataDir, { recursive: true });
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

// --- fake `claude` binaries -------------------------------------------------
// A binary that prints a live-sessions JSON array (and echoes its argv so we can
// assert --cwd passthrough into a side file).
const SAMPLE = [
  { pid: 100, cwd: "/repo/a", kind: "interactive", startedAt: 2000, sessionId: "aaa" },
  { pid: 200, cwd: "/repo/b", kind: "interactive", startedAt: 3000, sessionId: "bbb", status: "idle" },
];
const argvFile = path.join(tmp, "argv.txt");
const okBin = path.join(tmp, "claude-ok");
fs.writeFileSync(
  okBin,
  `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));
process.stdout.write(${JSON.stringify(JSON.stringify(SAMPLE))});
`,
);
fs.chmodSync(okBin, 0o755);
// The gateway route reads the module-level CLAUDE_BIN, captured at first import
// of src/background-agents — set it before that import (below) happens.
process.env.CONAN_CLAUDE_BIN = okBin;

// A binary that exits non-zero with non-JSON on stderr.
const failBin = path.join(tmp, "claude-fail");
fs.writeFileSync(
  failBin,
  `#!/usr/bin/env node
process.stderr.write('boom: not logged in');
process.exit(1);
`,
);
fs.chmodSync(failBin, 0o755);

// A binary that prints a JSON object (not an array).
const objBin = path.join(tmp, "claude-obj");
fs.writeFileSync(
  objBin,
  `#!/usr/bin/env node
process.stdout.write('{"error":"nope"}');
`,
);
fs.chmodSync(objBin, 0o755);

try {
  const mod = await import("../src/background-agents/index.ts");

  // --- pure normalizeAgents ----------------------------------------------
  const norm = mod.normalizeAgents(SAMPLE);
  check("normalizeAgents returns 2 rows", norm.length === 2);
  check("sorted newest-first by startedAt", norm[0].sessionId === "bbb" && norm[1].sessionId === "aaa");
  check("status present surfaced", norm[0].status === "idle");
  check("status absent → null", norm[1].status === null);
  check("pid/cwd/kind/startedAt normalized", norm[1].pid === 100 && norm[1].cwd === "/repo/a" && norm[1].kind === "interactive" && norm[1].startedAt === 2000);
  check("non-array input → empty", mod.normalizeAgents({ a: 1 }).length === 0 && mod.normalizeAgents(null).length === 0);
  check("non-object items skipped", mod.normalizeAgents([1, "x", null, { pid: 5, sessionId: "s" }]).length === 1);

  // --- readBackgroundAgents against the ok fake --------------------------
  const ok = await mod.readBackgroundAgents({ bin: okBin });
  check("ok: available true", ok.available === true && ok.error === null);
  check("ok: 2 agents", ok.agents.length === 2);

  // --cwd passthrough
  await mod.readBackgroundAgents({ bin: okBin, cwd: "/some/where" });
  const argv = fs.readFileSync(argvFile, "utf8");
  check("--cwd passed through to CLI", argv.includes("agents --json --cwd /some/where"));

  // non-zero exit, non-JSON → graceful empty
  const fail = await mod.readBackgroundAgents({ bin: failBin });
  check("fail: available false, empty list, error set", fail.available === false && fail.agents.length === 0 && typeof fail.error === "string");

  // JSON object (not array) → graceful empty
  const obj = await mod.readBackgroundAgents({ bin: objBin });
  check("non-array JSON → available false, empty", obj.available === false && obj.agents.length === 0);

  // missing binary → graceful empty (ENOENT)
  const missing = await mod.readBackgroundAgents({ bin: path.join(tmp, "nope-claude") });
  check("missing binary → available false, empty", missing.available === false && missing.agents.length === 0);

  // --- gateway route ------------------------------------------------------
  // The route uses the module-level CLAUDE_BIN (from CONAN_CLAUDE_BIN, set at
  // the top of this file before any import) — point it at the ok fake.
  await import("../src/gateway/index.ts");
  await sleep(300);

  const noAuth = await fetch(`${BASE}/api/claude/background-agents`);
  check("GET /background-agents without token is 401", noAuth.status === 401);

  const g = await (await fetch(`${BASE}/api/claude/background-agents`, { headers: { "x-conan-token": TOKEN } })).json();
  check("route returns agents array", Array.isArray(g.agents) && g.agents.length === 2);
  check("route reports available", g.available === true);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
