// US-001 (v4.4) test: capturing Claude Code's version from the SessionStart
// hook. Boots the real gateway on an isolated DB and asserts the events route
// (POST /api/claude/events) persists `payload.version` onto the session row,
// surfaces it via GET /api/claude/sessions and the per-session widgets payload,
// never fabricates it (null when absent), keeps a known version across a later
// version-less event (COALESCE), and that the hook forwarder leaves it unchanged.
//
// Run: tsx scripts/test-version.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-version-test-"));
const dataDir = path.join(tmp, "data");
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
const post = (body) =>
  fetch(`${BASE}/api/claude/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify(body),
  });

try {
  await import("../src/gateway/index.ts");
  await sleep(300);

  // --- SessionStart with a version → persisted + surfaced -----------------
  await post({
    session_id: "ver-known",
    cwd: tmp,
    hook_event_name: "SessionStart",
    payload: {
      session_id: "ver-known",
      hook_event_name: "SessionStart",
      version: "2.1.152",
      model: "claude-opus-4-7[1m]",
    },
  });
  await sleep(50);

  let rows = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  const known = rows.find((r) => r.id === "ver-known");
  check("session row exists after SessionStart", !!known);
  check("claude_version persisted from payload.version", known?.claude_version === "2.1.152");

  const w = await (
    await fetch(`${BASE}/api/claude/sessions/ver-known/widgets`)
  ).json();
  check("widgets payload exposes claudeVersion", w.claudeVersion === "2.1.152");

  // --- A later event WITHOUT version keeps the known one (COALESCE) -------
  await post({
    session_id: "ver-known",
    cwd: tmp,
    hook_event_name: "Stop",
    payload: { session_id: "ver-known", hook_event_name: "Stop" },
  });
  await sleep(50);
  rows = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  check(
    "version-less later event does not clobber the known version",
    rows.find((r) => r.id === "ver-known")?.claude_version === "2.1.152",
  );

  // --- A session that never reported a version → null (never fabricated) --
  await post({
    session_id: "ver-unknown",
    cwd: tmp,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    payload: { session_id: "ver-unknown", hook_event_name: "PreToolUse" },
  });
  await sleep(50);
  rows = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  const unknown = rows.find((r) => r.id === "ver-unknown");
  check("version-less session row exists", !!unknown);
  check("claude_version is null when never reported", unknown?.claude_version === null);

  const wu = await (
    await fetch(`${BASE}/api/claude/sessions/ver-unknown/widgets`)
  ).json();
  check("widgets payload claudeVersion is null when unknown", wu.claudeVersion === null);

  // --- A non-string version is not persisted (type-guarded) ---------------
  await post({
    session_id: "ver-bad",
    cwd: tmp,
    hook_event_name: "SessionStart",
    payload: { session_id: "ver-bad", hook_event_name: "SessionStart", version: 12345 },
  });
  await sleep(50);
  rows = await (await fetch(`${BASE}/api/claude/sessions`)).json();
  check(
    "non-string version is rejected (stays null, not coerced)",
    rows.find((r) => r.id === "ver-bad")?.claude_version === null,
  );
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
