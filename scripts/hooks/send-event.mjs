#!/usr/bin/env node
// Claude Code hook -> Conan gateway forwarder (US-004).
// Reads the hook payload on stdin and POSTs it to /api/claude/events.
// Fire-and-forget: short timeout, never throws, always exits 0 so it can never
// block or break the agent.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.CONAN_PORT ?? "3747";
// Resolve the auth token from the SAME data dir the running gateway uses. The
// Tauri app spawns the gateway with CONAN_DATA_DIR=<app-support>/… and the pty
// inherits it, so the hook must honor it too — otherwise it reads the repo's
// dev .data/auth-token, which won't match the app's token and every POST 401s
// (→ no events → empty Context/Pulse). Mirrors src/paths.ts DATA_DIR.
const DATA_DIR = process.env.CONAN_DATA_DIR ?? path.join(ROOT, ".data");

function token() {
  if (process.env.CONAN_AUTH_TOKEN) return process.env.CONAN_AUTH_TOKEN;
  try {
    return fs.readFileSync(path.join(DATA_DIR, "auth-token"), "utf8").trim();
  } catch {
    return "";
  }
}

// Nearest ancestor process named "claude" (US-001). The hook runs under a
// shell layer spawned by claude, so walk the ppid chain by process NAME —
// never assume a fixed depth. Claude Code 2.1.173 stopped writing
// ~/.claude/sessions/<pid>.json markers; this pid is the gateway's
// marker-independent correlation signal.
function findClaudePid() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      timeout: 1500,
    });
    const table = new Map();
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
    }
    let pid = process.ppid;
    for (let hops = 0; hops < 32 && pid > 1; hops++) {
      const row = table.get(pid);
      if (!row) break;
      if (path.basename(row.comm) === "claude") return pid;
      pid = row.ppid;
    }
  } catch {
    /* ps unavailable / timed out — omit claudePid */
  }
  return undefined;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  let data = {};
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  if (!data.session_id) process.exit(0);

  const claudePid = findClaudePid();
  const body = {
    session_id: data.session_id,
    cwd: data.cwd,
    hook_event_name: data.hook_event_name,
    tool_name: data.tool_name,
    parent_tool_use_id: data.parent_tool_use_id,
    ...(claudePid !== undefined ? { claudePid } : {}),
    payload: data,
  };

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/claude/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": token() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* gateway down / slow — drop the event, never block the agent */
  }
  process.exit(0);
});
