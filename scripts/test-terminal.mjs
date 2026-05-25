// US-017 test: per-session ring buffer with replay on reconnect.
// Boots the REAL gateway against a FAKE shell (a node script wired in via
// $SHELL + mode=shell), drives a terminal over /ws/terminal, then asserts:
//   1. a pty survives a client disconnect when the client passed a stable `tid`,
//   2. on reconnect the buffered backlog is replayed BEFORE live output resumes,
//   3. the ring buffer is capped and oldest output is evicted.
//
// Run: tsx scripts/test-terminal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-term-test-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3500 + Math.floor(Math.random() * 200);
const RING_BYTES = 200;

// Fake "shell": print START, then echo OUT:<line> for each stdin line; stay alive.
const stub = path.join(tmp, "fake-shell.mjs");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
process.stdout.write("START\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).replace(/\\r$/, "");
    buf = buf.slice(nl + 1);
    if (line) process.stdout.write("OUT:" + line + "\\n");
  }
});
process.stdin.resume();
setTimeout(() => process.exit(0), 15000);
`,
);
fs.chmodSync(stub, 0o755);

// Point the gateway at the fake shell + isolated DB + known token/port, and at a
// small ring cap so eviction is exercisable.
process.env.SHELL = stub;
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.CONAN_TERM_RING_BYTES = String(RING_BYTES);
process.env.CONAN_TERM_GRACE_MS = "8000";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a terminal WS for a given tid; collects every received frame.
function connect(tid) {
  const url = `ws://127.0.0.1:${PORT}/ws/terminal?token=${TOKEN}&mode=shell&tid=${tid}`;
  const ws = new WebSocket(url);
  const frames = [];
  ws.on("message", (d) => frames.push(d.toString()));
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  return {
    ws,
    frames,
    ready,
    text: () => frames.join(""),
    send: (msg) => ws.send(JSON.stringify(msg)),
    input: (line) => ws.send(JSON.stringify({ type: "input", data: line + "\n" })),
    close: () => ws.close(),
  };
}

async function waitFor(pred, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(40);
  }
  return false;
}

try {
  await import("../src/gateway/index.ts");
  await sleep(300); // let the server bind

  // ===== Flow A: survive disconnect + replay backlog before live ============
  const T1 = "term-A-" + Math.random().toString(36).slice(2, 8);
  const c1 = connect(T1);
  await c1.ready;
  check("connected with a tid", c1.ws.readyState === WebSocket.OPEN);

  c1.input("AAA");
  check("live output arrives on first connect", await waitFor(() => c1.text().includes("OUT:AAA")));

  c1.close();
  await sleep(200); // pty must survive this (persistent tid + grace window)

  const c2 = connect(T1);
  await c2.ready;
  await sleep(150); // let the replay frame land
  const replayA = c2.frames[0] ?? "";
  check("reconnect replays the backlog as the first frame", replayA.includes("OUT:AAA"));
  check("replayed backlog includes earlier output (START)", replayA.includes("START"));

  // Live output resumes on the SAME pty after replay.
  c2.input("BBB");
  check("live output resumes after reconnect", await waitFor(() => c2.text().includes("OUT:BBB")));
  check("the new live output was not part of the replay", !replayA.includes("OUT:BBB"));
  c2.close();

  // ===== Flow B: ring buffer is capped and oldest output is evicted =========
  const T2 = "term-B-" + Math.random().toString(36).slice(2, 8);
  const c3 = connect(T2);
  await c3.ready;
  for (let i = 0; i <= 40; i++) c3.input("L" + i); // >> RING_BYTES of output
  check("produced output beyond the ring cap", await waitFor(() => c3.text().includes("OUT:L40")));
  c3.close();
  await sleep(200);

  const c4 = connect(T2);
  await c4.ready;
  await sleep(150);
  const replayB = c4.frames[0] ?? "";
  check("capped replay stays within the ring byte cap", Buffer.byteLength(replayB) <= RING_BYTES);
  check("oldest output (OUT:L0) was evicted", !replayB.includes("OUT:L0\n"));
  check("most-recent output (OUT:L40) was retained", replayB.includes("OUT:L40"));
  c4.close();

  // ===== Flow C: an explicit {type:'close'} kills the pty now (US-026) ========
  // A closed tab must NOT survive the grace window: reconnecting with the same
  // tid spawns a FRESH pty (a new START, none of the prior CCC backlog).
  const T3 = "term-C-" + Math.random().toString(36).slice(2, 8);
  const c5 = connect(T3);
  await c5.ready;
  c5.input("CCC");
  check("flow-C live output arrives", await waitFor(() => c5.text().includes("OUT:CCC")));
  c5.send({ type: "close" }); // explicit tab close → destroy pty + DB row
  c5.close();
  await sleep(300);

  const c6 = connect(T3);
  await c6.ready;
  await sleep(200);
  const afterClose = c6.text();
  check("after explicit close, a reconnect gets a FRESH pty (no CCC backlog)", !afterClose.includes("OUT:CCC"));
  check("the fresh pty started cleanly (new START)", afterClose.includes("START"));
  c6.send({ type: "close" });
  c6.close();

  await sleep(100);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
