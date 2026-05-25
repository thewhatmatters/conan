// US-013 browser-verification harness: boot the REAL gateway (serving the built
// UI) against a FAKE `claude` that opens a tool-permission prompt and stays
// alive, then start two sessions so the cross-session pending-approvals widget
// has real items. Leaves the gateway running on :3747 for automate-browser.
//
// Run: tsx scripts/verify-approvals.mjs   (Ctrl-C to stop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-approvals-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "verify-token";
const PORT = 3766;
const BASE = `http://127.0.0.1:${PORT}`;

// Fake `claude`: emit system/init with a per-process random session_id, then a
// can_use_tool control_request (tool + command derived from --model so the two
// sessions differ), and idle on stdin so the prompt stays open.
const stub = path.join(tmp, "fake-claude.mjs");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const mi = argv.indexOf("--model");
const model = mi !== -1 ? argv[mi + 1] : "sonnet";
const sid = "sess-" + model + "-" + Math.random().toString(36).slice(2, 8);
const init = { type: "system", subtype: "init", session_id: sid, model: "claude-" + model + "-4-6", tools: [], cwd: process.cwd() };
process.stdout.write(JSON.stringify(init) + "\\n");
setTimeout(() => {
  const isOpus = model.includes("opus");
  const req = isOpus
    ? { type: "control_request", request_id: "perm-" + process.pid, request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/etc/hosts", content: "x" } } }
    : { type: "control_request", request_id: "perm-" + process.pid, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf build && npm run deploy" } } };
  process.stdout.write(JSON.stringify(req) + "\\n");
}, 100);
process.stdin.resume();
setTimeout(() => process.exit(0), 600000);
`,
);
fs.chmodSync(stub, 0o755);

process.env.CONAN_CLAUDE_BIN = stub;
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (pathname, body) =>
  fetch(BASE + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify(body ?? {}),
  });

await import("../src/gateway/index.ts");
await sleep(400);

await post("/api/claude/sessions", { cwd: tmp, model: "sonnet" });
await post("/api/claude/sessions", { cwd: tmp, model: "opus" });
await sleep(400);

const pending = await (await fetch(BASE + "/api/claude/permissions")).json();
console.log(`\n[verify] ${pending.length} pending permission(s):`);
for (const p of pending) console.log(`  - ${p.sessionId}  ${p.toolName}  req=${p.requestId}`);
console.log(`\n[verify] gateway live on ${BASE} (token=${TOKEN}). Ctrl-C to stop.`);

process.on("SIGINT", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
