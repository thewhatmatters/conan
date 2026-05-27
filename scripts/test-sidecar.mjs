// US-008 verification: run the PACKAGED gateway sidecar binary directly (no
// Tauri) and prove the two native addons survived bundling — the dominant
// packaging risk (see docs/sidecar.md):
//
//   1. better-sqlite3 — GET /api/health opens the DB and queries sqlite_master,
//      so a 200 with a non-empty `tables` array means the .node loaded and the
//      schema applied.
//   2. node-pty / spawn-helper — open a terminal WS, run `echo`, and confirm the
//      output comes back: that requires pty.spawn → posix_spawnp via the
//      spawn-helper that so often loses its +x bit post-bundle.
//
// Build first: `npm run build:sidecar`. Run: `npm run test:sidecar`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRIPLE =
  process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const BINARY = path.join(ROOT, "src-tauri", "binaries", `conan-gateway-${TRIPLE}`);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(BINARY)) {
  console.log(`FAIL - sidecar binary not found at ${path.relative(ROOT, BINARY)}`);
  console.log("       run `npm run build:sidecar` first.");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-sidecar-test-"));
const TOKEN = "sidecar-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);

// Run the real packaged binary as its own process (NOT imported in-process),
// pointed at an isolated DB + known token/port.
const child = spawn(BINARY, [], {
  env: {
    ...process.env,
    CONAN_DATA_DIR: path.join(tmp, "data"),
    CONAN_AUTH_TOKEN: TOKEN,
    CONAN_PORT: String(PORT),
    // No SHELL override: exercise a plain shell pty.
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stdout.on("data", (d) => process.stdout.write(`[gateway] ${d}`));
child.stderr.on("data", (d) => {
  stderr += d.toString();
  process.stderr.write(`[gateway] ${d}`);
});

async function waitForHealth(ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return null;
}

try {
  // ===== better-sqlite3: the binary boots, opens the DB, answers health =====
  const health = await waitForHealth();
  check("binary launched and serves GET /api/health (200)", health !== null);
  check(
    "health is { status: 'ok' } (better-sqlite3 DB opened)",
    health?.status === "ok",
  );
  check(
    "health lists DB tables (sqlite_master query succeeded)",
    Array.isArray(health?.tables) && health.tables.length > 0,
  );

  // ===== node-pty / spawn-helper: spawn a pty and run a command =============
  if (health) {
    const marker = "CONAN_PTY_OK_" + Math.random().toString(36).slice(2, 8);
    const url = `ws://127.0.0.1:${PORT}/ws/terminal?token=${TOKEN}&mode=shell`;
    const ws = new WebSocket(url);
    let out = "";
    ws.on("message", (d) => (out += d.toString()));
    const opened = await new Promise((res) => {
      ws.on("open", () => res(true));
      ws.on("error", () => res(false));
      setTimeout(() => res(false), 4000);
    });
    check("terminal WS opened (pty spawned via node-pty)", opened);

    if (opened) {
      await sleep(300); // let the shell start
      ws.send(JSON.stringify({ type: "input", data: `echo ${marker}\n` }));
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !out.includes(marker)) await sleep(50);
      check(
        "pty produced command output (spawn-helper kept its +x bit)",
        out.includes(marker),
      );
      ws.send(JSON.stringify({ type: "close" }));
      ws.close();
    }
    check(
      "no posix_spawnp failure in gateway stderr",
      !/posix_spawnp/i.test(stderr),
    );
  }
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  child.kill("SIGTERM");
  await sleep(200);
  if (!child.killed) child.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nSIDECAR TESTS FAILED" : "\nALL SIDECAR TESTS PASSED");
process.exit(failed ? 1 : 0);
