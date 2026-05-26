// US-010 test: live-preview backend — dev-server process manager + dev-command
// discovery. Exercises the pure module (discovery order, port-pinning) and then
// the gateway routes end-to-end, including a REAL Vite preview against ui/:
//   - GET /api/preview/status reports discovered candidates (dev → start → preview)
//   - POST /api/preview/start is token-gated; starting spawns a real dev server
//   - the status route then reports a bound port + running state + chosen command
//   - POST /api/preview/stop kills it and status returns to idle
//
// Run: tsx scripts/test-preview.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(REPO_ROOT, "ui");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-preview-test-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3500 + Math.floor(Math.random() * 200);
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

try {
  // --- pure module --------------------------------------------------------
  const preview = await import("../src/preview/index.ts");
  const cwdMod = await import("../src/cwd/index.ts");

  const disc = preview.discoverCommands(UI_DIR);
  check("discovery finds the ui/ dev script", disc.candidates.some((c) => c.script === "dev"));
  check("discovery default is 'dev' (preference order)", disc.defaultScript === "dev");
  check("discovery flags the dev script as Vite", disc.candidates.find((c) => c.script === "dev")?.vite === true);

  const noPkg = preview.discoverCommands(tmp);
  check("discovery on a dir without package.json degrades with error", noPkg.error !== undefined && noPkg.defaultScript === null);

  check("status is idle before any start", preview.previewStatus().state === "idle" && preview.previewStatus().active === false);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  // Point the active cwd at ui/ so the preview runs the dashboard's own Vite.
  const put = await fetch(`${BASE}/api/cwd`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ cwd: UI_DIR }),
  });
  check("PUT /api/cwd switched to ui/", put.ok);

  const status0 = await (await fetch(`${BASE}/api/preview/status`)).json();
  check("GET /api/preview/status lists ui/ candidates", status0.discovery.candidates.some((c) => c.script === "dev"));
  check("GET /api/preview/status idle before start", status0.status.state === "idle");

  // start is token-gated
  const noAuth = await fetch(`${BASE}/api/preview/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("POST /api/preview/start without token is 401", noAuth.status === 401);

  // Start a real Vite preview.
  const start = await fetch(`${BASE}/api/preview/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: "{}",
  });
  const startJson = await start.json();
  check("POST /api/preview/start -> ok", start.ok && startJson.ok);
  check("start chose the 'dev' script + Vite", startJson.status?.script === "dev" && startJson.status?.vite === true);
  check("start pinned a port in the command", /--port \d+/.test(startJson.status?.command ?? ""));
  check("start set --base /preview/<id>/", (startJson.status?.command ?? "").includes(`--base /preview/${startJson.status?.id}/`));

  // Poll the status route until Vite confirms it's listening (bound port + running).
  let running = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const s = await (await fetch(`${BASE}/api/preview/status`)).json();
    if (s.status.state === "running" && typeof s.status.port === "number") {
      running = s.status;
      break;
    }
    if (s.status.state === "exited" || s.status.state === "error") {
      console.log("    preview ended early:", JSON.stringify(s.status));
      break;
    }
  }
  check("status route reports a running preview", running?.state === "running");
  check("status route reports a bound port", typeof running?.port === "number" && running.port > 0);
  check("bound port matches the pinned port in the command", new RegExp(`--port ${running?.port}\\b`).test(running?.command ?? ""));

  // Confirm the dev server is actually answering on the bound port.
  if (running?.port) {
    try {
      const ping = await fetch(`http://127.0.0.1:${running.port}/preview/${running.id}/`);
      check("dev server answers HTTP on the bound port", ping.status > 0);
    } catch (e) {
      check("dev server answers HTTP on the bound port", false);
    }
  }

  // Stop it.
  const stop = await fetch(`${BASE}/api/preview/stop`, {
    method: "POST",
    headers: { "x-conan-token": TOKEN },
  });
  const stopJson = await stop.json();
  check("POST /api/preview/stop -> stopped", stop.ok && stopJson.stopped === true);

  await sleep(300);
  const status1 = await (await fetch(`${BASE}/api/preview/status`)).json();
  check("status returns to idle after stop", status1.status.state === "idle" && status1.status.active === false);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
