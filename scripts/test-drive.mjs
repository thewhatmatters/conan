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
import { execFileSync } from "node:child_process";
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
import path from "node:path";
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
const ri = argv.indexOf("--resume");
const si = argv.indexOf("--json-schema");
const hasInput = argv.includes("--input-format");
const lastArg = argv[argv.length - 1];
// Pick a session id that won't collide across the suite's many launches:
// resume reuses the id; a worktree run derives from its cwd (US-043); a
// one-shot prompt run (US-044 schema tests) derives from the prompt; the
// stdin-driven primary session is FIXED_ID.
const sid = ri !== -1 && argv[ri + 1] ? argv[ri + 1]
  : process.cwd().includes(".conan-worktrees") ? "wt-" + path.basename(process.cwd())
  : !hasInput ? "p-" + lastArg
  : ${JSON.stringify(FIXED_ID)};
const init = { type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-4-6", tools: [], cwd: process.cwd() };
process.stdout.write(JSON.stringify(init) + "\\n");
if (si !== -1) {
  // US-044: a --json-schema run emits a fixed structured result then exits, so
  // the manager can capture + validate it against whichever schema was passed.
  const result = { type: "result", subtype: "success", session_id: sid, result: JSON.stringify({ status: "done", files: 3 }), total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } };
  process.stdout.write(JSON.stringify(result) + "\\n");
  setTimeout(() => process.exit(0), 50);
} else {
  // Emit a tool-permission control_request so the driver can answer it (US-012).
  setTimeout(() => {
    const req = { type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } };
    process.stdout.write(JSON.stringify(req) + "\\n");
  }, 80);
}
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

const sessionRow = (id) => {
  const db = new Database(path.join(dataDir, "conan.db"), { readonly: true });
  try {
    return db.prepare("SELECT * FROM session WHERE id = ?").get(id) ?? null;
  } finally {
    db.close();
  }
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

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

  // --- US-043: worktree-isolated driven session -------------------------
  // Stand up a real git repo with one commit so `git worktree add` works.
  const repoDir = path.join(tmp, "repo");
  fs.mkdirSync(repoDir);
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "test@conan.dev");
  git(repoDir, "config", "user.name", "Conan Test");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "init");
  const baseSha = git(repoDir, "rev-parse", "--short", "HEAD");

  // Start with worktree:true + an --add-dir; assert the worktree was minted,
  // surfaced on the row, and the session ran inside it (not the repo root).
  const wtRes = await post("/api/claude/sessions", {
    cwd: repoDir,
    worktree: true,
    add_dir: [tmp],
  });
  const wtBody = await wtRes.json();
  check("worktree start returns 200", wtRes.status === 200);
  check("worktree start surfaces a worktree", wtBody.worktree && typeof wtBody.worktree.path === "string");
  check("worktree path is under .conan-worktrees", (wtBody.worktree?.path ?? "").includes(".conan-worktrees"));
  check("worktree base ref is the HEAD short sha", wtBody.worktree?.baseRef === baseSha);
  check("worktree dir exists on disk", fs.existsSync(wtBody.worktree?.path ?? "/nope"));
  check("worktree branch was created", git(repoDir, "branch", "--list", wtBody.worktree?.branch ?? "x").length > 0);
  check("worktree is a registered git worktree", git(repoDir, "worktree", "list").includes(wtBody.worktree?.path ?? "\0"));

  const wtSid = wtBody.sessionId;
  check("worktree session captured a distinct id", typeof wtSid === "string" && wtSid !== FIXED_ID);

  const wtArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop());
  check("worktree start passed --add-dir <dir>", wtArgv.includes("--add-dir") && wtArgv[wtArgv.indexOf("--add-dir") + 1] === tmp);

  const wtRow = sessionRow(wtSid);
  check("session row records the worktree cwd", wtRow?.cwd === wtBody.worktree?.path);
  check("session row records the worktree path", wtRow?.worktree_path === wtBody.worktree?.path);
  check("session row records the worktree base ref", wtRow?.worktree_base_ref === baseSha);

  // --- US-043: defaults unchanged when worktree unused ------------------
  const plainRow = sessionRow(FIXED_ID);
  check("non-worktree session has null worktree_path", plainRow?.worktree_path == null);

  // --- US-043: teardown removes the worktree on stop --------------------
  const wtStopRes = await post(`/api/claude/sessions/${encodeURIComponent(wtSid)}/stop`, { remove_worktree: true });
  const wtStopBody = await wtStopRes.json();
  check("worktree stop returns 200", wtStopRes.status === 200);
  check("worktree was removed on stop", wtStopBody.worktreeRemoved === true);
  await sleep(150);
  check("worktree dir is gone after teardown", !fs.existsSync(wtBody.worktree?.path ?? "/nope"));
  check("worktree no longer registered with git", !git(repoDir, "worktree", "list").includes(wtBody.worktree?.path ?? "\0"));
  check("session row worktree path cleared after teardown", sessionRow(wtSid)?.worktree_path == null);

  // --- US-043: worktree on a non-repo cwd is a clean 400 ----------------
  const nonRepo = path.join(tmp, "not-a-repo");
  fs.mkdirSync(nonRepo);
  const badWtRes = await post("/api/claude/sessions", { cwd: nonRepo, worktree: true });
  check("worktree on non-repo cwd returns 400", badWtRes.status === 400);

  // --- US-044: --json-schema typed outputs for driven tasks -------------
  // Poll the session row until `pred(row)` holds (the result lands async).
  async function waitForRow(id, pred, ms = 3000) {
    const deadline = Date.now() + ms;
    let row = sessionRow(id);
    while (Date.now() < deadline) {
      if (row && pred(row)) return row;
      await sleep(50);
      row = sessionRow(id);
    }
    return row;
  }

  // (a) valid result against its schema -> captured + schema_valid=1.
  const validSchema = {
    type: "object",
    properties: { status: { type: "string" }, files: { type: "integer" } },
    required: ["status", "files"],
  };
  const okRes = await post("/api/claude/sessions", { cwd: tmp, prompt: "schematask-valid", json_schema: validSchema });
  const okBody = await okRes.json();
  check("json-schema start returns 200", okRes.status === 200);
  check("json-schema start captured the session id", okBody.sessionId === "p-schematask-valid");

  const okArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop());
  check("start passes --json-schema <file>", okArgv.includes("--json-schema") && typeof okArgv[okArgv.indexOf("--json-schema") + 1] === "string");

  const okRow = await waitForRow("p-schematask-valid", (r) => r.structured_result != null);
  check("schema persisted on the session row", JSON.stringify(JSON.parse(okRow?.json_schema ?? "null")) === JSON.stringify(validSchema));
  check("structured result captured", JSON.stringify(JSON.parse(okRow?.structured_result ?? "null")) === JSON.stringify({ status: "done", files: 3 }));
  check("conforming result marked schema_valid=1", okRow?.schema_valid === 1);

  // result is also surfaced via the session grid (GET /api/claude/sessions).
  const grid = await (await fetch(BASE + "/api/claude/sessions", { headers: { "x-conan-token": TOKEN } })).json();
  const okGridRow = grid.find((s) => s.id === "p-schematask-valid");
  check("structured result surfaced on the grid", okGridRow?.schema_valid === 1 && okGridRow?.structured_result != null);

  // (b) same result against a stricter schema it violates -> schema_valid=0.
  const strictSchema = {
    type: "object",
    properties: { status: { type: "number" } },
    required: ["status", "must_exist"],
  };
  const badRes = await post("/api/claude/sessions", { cwd: tmp, prompt: "schematask-invalid", json_schema: strictSchema });
  await badRes.json();
  const badRow = await waitForRow("p-schematask-invalid", (r) => r.structured_result != null);
  check("non-conforming result marked schema_valid=0", badRow?.schema_valid === 0);
  check("non-conforming result still captured", badRow?.structured_result != null);

  // (c) malformed schema is ignored: defaults unchanged, no --json-schema flag.
  const malRes = await post("/api/claude/sessions", { cwd: tmp, prompt: "schematask-malformed", json_schema: "not-a-schema" });
  const malBody = await malRes.json();
  check("malformed-schema start still returns 200", malRes.status === 200);
  const malArgv = JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").pop());
  check("malformed schema not passed to argv", !malArgv.includes("--json-schema"));
  const malRow = await waitForRow("p-schematask-malformed", () => true, 300);
  check("malformed-schema row has null json_schema", malRow?.json_schema == null);

  // (d) absent schema: the primary FIXED_ID session was driven with no schema.
  const plainSchemaRow = sessionRow(FIXED_ID);
  check("no-schema session has null json_schema/result", plainSchemaRow?.json_schema == null && plainSchemaRow?.structured_result == null && plainSchemaRow?.schema_valid == null);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
