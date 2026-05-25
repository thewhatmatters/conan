#!/usr/bin/env node
// Claude Code hook -> Conan gateway forwarder (US-004).
// Reads the hook payload on stdin and POSTs it to /api/claude/events.
// Fire-and-forget: short timeout, never throws, always exits 0 so it can never
// block or break the agent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.CONAN_PORT ?? "3747";

function token() {
  if (process.env.CONAN_AUTH_TOKEN) return process.env.CONAN_AUTH_TOKEN;
  try {
    return fs.readFileSync(path.join(ROOT, ".data", "auth-token"), "utf8").trim();
  } catch {
    return "";
  }
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

  const body = {
    session_id: data.session_id,
    cwd: data.cwd,
    hook_event_name: data.hook_event_name,
    tool_name: data.tool_name,
    parent_tool_use_id: data.parent_tool_use_id,
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
