// US-006 test: start a headless Claude Code session via stream-json.
// Runs against a FAKE `claude` binary (no API key / network needed) that emits
// a real stream-json system/init line, then verifies the session manager
// captures the session_id, tracks the child handle, and persists the row.
//
// Run: node scripts/test-session.mjs   (spawns tsx to load the TS module)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-session-test-"));
const dataDir = path.join(tmp, "data");
const argvDump = path.join(tmp, "argv.json");
const FAKE_SESSION_ID = "test-session-" + Math.random().toString(36).slice(2, 10);

// Fake `claude`: record argv, emit system/init, then idle on stdin so the
// process stays alive long enough to mimic a driveable session.
const stub = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));
const init = { type: "system", subtype: "init", session_id: ${JSON.stringify(
    FAKE_SESSION_ID,
  )}, model: "claude-sonnet-4-6", tools: [], cwd: process.cwd() };
process.stdout.write(JSON.stringify(init) + "\\n");
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
`,
);
fs.chmodSync(stub, 0o755);

// Point the manager at the stub + an isolated DB before importing it.
process.env.CONAN_CLAUDE_BIN = stub; // executable via its #!/usr/bin/env node shebang
process.env.CONAN_DATA_DIR = dataDir;

const { startSession, getManagedSession, listManagedSessions } = await import(
  pathToFileURL(path.resolve("src/session/index.ts")).href
);
const { getDb, closeDb } = await import(
  pathToFileURL(path.resolve("src/db/index.ts")).href
);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

try {
  const result = startSession({
    cwd: tmp,
    model: "sonnet",
    permissionMode: "acceptEdits",
    bare: true,
  });

  check("returns a launchId", typeof result.launchId === "string" && result.launchId.length > 0);
  check("returns a live child handle", !!result.child && typeof result.child.pid === "number");

  const sessionId = await Promise.race([
    result.sessionId,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for init")), 8000)),
  ]);

  check("captures session_id from system/init", sessionId === FAKE_SESSION_ID);
  check("tracks the child keyed by session_id", getManagedSession(sessionId)?.child === result.child);
  check("session appears in listManagedSessions", listManagedSessions().some((s) => s.sessionId === sessionId));

  // Faithful to the acceptance criteria flags.
  const argv = JSON.parse(fs.readFileSync(argvDump, "utf8"));
  check("spawns with -p", argv.includes("-p"));
  check("spawns --output-format stream-json", argv.join(" ").includes("--output-format stream-json"));
  check("spawns --verbose", argv.includes("--verbose"));
  check("spawns --include-partial-messages", argv.includes("--include-partial-messages"));
  check("passes --model sonnet", argv.join(" ").includes("--model sonnet"));
  check("passes --permission-mode acceptEdits", argv.join(" ").includes("--permission-mode acceptEdits"));
  check("supports --bare", argv.includes("--bare"));

  // Persisted to the session table with running status + metadata.
  const row = getDb().prepare("SELECT * FROM session WHERE id = ?").get(sessionId);
  check("persists a session row", !!row);
  check("row status is running", row?.status === "running");
  check("row records model", row?.model === "sonnet");
  check("row records permission_mode", row?.permission_mode === "acceptEdits");
  check("row records cwd", row?.cwd === tmp);

  result.child.kill();
  closeDb();
} catch (err) {
  console.log("FAIL - threw:", err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
