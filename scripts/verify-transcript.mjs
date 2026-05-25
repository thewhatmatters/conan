// US-014 browser-verification harness: boot the REAL gateway (serving the built
// UI) and seed two session rows via the events-ingest route — one whose id +
// cwd point at a REAL Claude Code transcript on disk under ~/.claude, and one
// with no transcript file — so the Transcript tab can be checked both ways.
//
// Run: tsx scripts/verify-transcript.mjs   (Ctrl-C to stop)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-transcript-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "verify-token";
const PORT = 3767;
const BASE = `http://127.0.0.1:${PORT}`;

// A real session transcript that exists on this machine, and the cwd whose
// encoded folder holds it (/ and . -> -).
const REAL_CWD = "/Users/digitalalchemist/Development/conan";
const REAL_ID = "ee875f37-568d-49e2-a947-d507c8c4a1e5";
const projectDir = path.join(os.homedir(), ".claude", "projects", REAL_CWD.replace(/[/.]/g, "-"));
if (!fs.existsSync(path.join(projectDir, REAL_ID + ".jsonl"))) {
  console.error(`[verify] expected transcript missing: ${projectDir}/${REAL_ID}.jsonl`);
  process.exit(1);
}

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

// Upsert two session rows through the ingest route (no live `claude` needed).
await post("/api/claude/events", {
  session_id: REAL_ID,
  cwd: REAL_CWD,
  hook_event_name: "SessionStart",
});
await post("/api/claude/events", {
  session_id: "no-transcript-session-0001",
  cwd: "/tmp/conan-nowhere",
  hook_event_name: "SessionStart",
});
await sleep(200);

const t = await (await fetch(BASE + `/api/claude/sessions/${REAL_ID}/transcript`)).json();
const empty = await (await fetch(BASE + `/api/claude/sessions/no-transcript-session-0001/transcript`)).json();
console.log(`\n[verify] real transcript: found=${t.found} messages=${t.messages.length}`);
console.log(`[verify] missing transcript: found=${empty.found} messages=${empty.messages.length}`);
console.log(`\n[verify] gateway live on ${BASE} (token=${TOKEN}). Ctrl-C to stop.`);

process.on("SIGINT", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
});
