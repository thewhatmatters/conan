// US-008 test: drive a headless session over the REST control plane
// (start / sendPrompt / stop / resume) via the real gateway, against a FAKE
// `claude` binary (no API key / network needed). The stub records its argv and
// any stream-json stdin it receives so we can assert the manager actually
// routes prompts to the live process and relaunches with --resume.
//
// Run: tsx scripts/test-drive.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-drive-test-"));
const dataDir = path.join(tmp, "data");
const argvLog = path.join(tmp, "argv.log"); // one JSON argv array per launch
const stdinLog = path.join(tmp, "stdin.log"); // one stream-json input line per turn
const FIXED_ID = "drive-session-" + Math.random().toString(36).slice(2, 10);
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

// Fake `claude`: log argv, emit system/init (reusing the --resume id when
// present so a resumed launch keeps the same session_id), then echo every
// stdin line into stdinLog and idle so it stays driveable.
const stub = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
const ri = argv.indexOf("--resume");
const sid = ri !== -1 && argv[ri + 1] ? argv[ri + 1] : ${JSON.stringify(FIXED_ID)};
const init = { type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-4-6", tools: [], cwd: process.cwd() };
process.stdout.write(JSON.stringify(init) + "\\n");
// Emit a tool-permission control_request so the driver can answer it (US-012).
setTimeout(() => {
  const req = { type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } };
  process.stdout.write(JSON.stringify(req) + "\\n");
}, 80);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) fs.appendFileSync(${JSON.stringify(stdinLog)}, line + "\\n");
  }
});
process.stdin.resume();
setTimeout(() => process.exit(0), 8000);
`,
);
fs.chmodSync(stub, 0o755);

// Point the gateway at the stub + an isolated DB + a known token/port.
process.env.CONAN_CLAUDE_BIN = stub;
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a log file until `pred(text)` holds or we time out.
async function waitFor(file, pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (pred(text)) return text;
    await sleep(50);
  }
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

const post = (pathname, body, token = TOKEN) =>
  fetch(BASE + pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-conan-token": token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

const sessionStatus = () => {
  const db = new Database(path.join(dataDir, "conan.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT status FROM session WHERE id = ?").get(FIXED_ID);
    return row?.status ?? null;
  } finally {
    db.close();
  }
};

try {
  // Boot the real gateway in-process.
  await import("../src/gateway/index.ts");
  await sleep(300); // let the server bind

  // --- auth gate on every control route ---------------------------------
  check("start rejects missing token (401)", (await post("/api/claude/sessions", {}, null)).status === 401);
  check("prompt rejects missing token (401)", (await post(`/api/claude/sessions/${FIXED_ID}/prompt`, { text: "x" }, null)).status === 401);
  check("stop rejects missing token (401)", (await post(`/api/claude/sessions/${FIXED_ID}/stop`, {}, null)).status === 401);
  check("resume rejects missing token (401)", (await post(`/api/claude/sessions/${FIXED_ID}/resume`, {}, null)).status === 401);

  // --- start ------------------------------------------------------------
  const startRes = await post("/api/claude/sessions", {
    cwd: tmp,
    model: "sonnet",
    permission_mode: "acceptEdits",
    effort: "high",
    from_pr: "1234",
  });
  const startBody = await startRes.json();
  check("start returns 200", startRes.status === 200);
  check("start captures the session_id", startBody.sessionId === FIXED_ID);
  check("start tracks a launchId", typeof startBody.launchId === "string" && startBody.launchId.length > 0);
  check("session row is running after start", sessionStatus() === "running");

  // --- US-042: start passed --effort and --from-pr through to argv -------
  const firstLaunch = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n")[0]);
  check("start passes --effort <level>", firstLaunch.includes("--effort") && firstLaunch[firstLaunch.indexOf("--effort") + 1] === "high");
  check("start passes --from-pr <n>", firstLaunch.includes("--from-pr") && firstLaunch[firstLaunch.indexOf("--from-pr") + 1] === "1234");

  // --- US-042: invalid effort is rejected with a clear error (400) ------
  const badEffortRes = await post("/api/claude/sessions", { cwd: tmp, effort: "ludicrous" });
  check("start rejects invalid effort (400)", badEffortRes.status === 400);
  check("invalid-effort error names the bad value", (await badEffortRes.json()).error?.includes("ludicrous"));

  // --- sendPrompt to the LIVE process -----------------------------------
  check("prompt rejects empty text (400)", (await post(`/api/claude/sessions/${FIXED_ID}/prompt`, { text: "" })).status === 400);

  const promptRes = await post(`/api/claude/sessions/${FIXED_ID}/prompt`, { text: "hello loop" });
  const promptBody = await promptRes.json();
  check("prompt returns 200", promptRes.status === 200);
  check("prompt routed to live process (not resumed)", promptBody.resumed === false);

  const stdinText = await waitFor(stdinLog, (t) => t.includes("hello loop"));
  check("prompt was written to the live stdin as stream-json", /"type":"user"/.test(stdinText) && stdinText.includes("hello loop"));

  // --- permission decision (US-012) -------------------------------------
  check("permission rejects missing token (401)", (await post(`/api/claude/sessions/${FIXED_ID}/permission`, { request_id: "perm-1", decision: "allow" }, null)).status === 401);
  check("permission rejects bad decision (400)", (await post(`/api/claude/sessions/${FIXED_ID}/permission`, { request_id: "perm-1", decision: "maybe" })).status === 400);

  const permRes = await post(`/api/claude/sessions/${FIXED_ID}/permission`, { request_id: "perm-1", decision: "allow" });
  const permBody = await permRes.json();
  check("permission returns 200", permRes.status === 200);
  check("permission delivered to live child", permBody.delivered === true);
  check("permission resolved the request id", permBody.requestId === "perm-1");

  const permStdin = await waitFor(stdinLog, (t) => t.includes("control_response"));
  check("control_response written to stdin as stream-json", /"type":"control_response"/.test(permStdin));
  check("control_response carries the request id + allow behavior", permStdin.includes("perm-1") && /"behavior":"allow"/.test(permStdin));

  // --- stop -------------------------------------------------------------
  const stopRes = await post(`/api/claude/sessions/${FIXED_ID}/stop`, {});
  const stopBody = await stopRes.json();
  check("stop returns 200", stopRes.status === 200);
  check("stop found a live child", stopBody.stopped === true);
  await sleep(150);
  check("session row is idle after stop", sessionStatus() === "idle");

  // --- resume (dormant) -------------------------------------------------
  const launchesBefore = fs.readFileSync(argvLog, "utf8").trim().split("\n").length;
  const resumeRes = await post(`/api/claude/sessions/${FIXED_ID}/resume`, {
    fork_session: true,
  });
  const resumeBody = await resumeRes.json();
  check("resume returns 200", resumeRes.status === 200);
  check("resume keeps the same session_id", resumeBody.sessionId === FIXED_ID);

  const argvText = await waitFor(
    argvLog,
    (t) => t.trim().split("\n").length > launchesBefore,
  );
  const lastLaunch = JSON.parse(argvText.trim().split("\n").pop());
  check("resume launched a fresh process", argvText.trim().split("\n").length === launchesBefore + 1);
  check("resume passes --resume <id>", lastLaunch.includes("--resume") && lastLaunch.includes(FIXED_ID));
  check("resume re-attaches the stream-json contract", lastLaunch.join(" ").includes("--output-format stream-json") && lastLaunch.includes("--input-format"));
  check("session row is running again after resume", sessionStatus() === "running");
  // --- US-042: --fork-session passed through on resume ------------------
  check("resume passes --fork-session", lastLaunch.includes("--fork-session"));
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
