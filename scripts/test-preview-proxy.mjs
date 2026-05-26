// US-011 test: live-preview reverse proxy + HMR-WS upgrade + framing-header strip.
// Boots the gateway, runs a real preview, and exercises the proxy end-to-end:
//   A) a real Vite preview (ui/) served same-origin under /preview/:id —
//      - GET /preview/<id>/ returns the dev page WITHOUT a token (the iframe
//        path relies on same-origin + loopback, not x-conan-token)
//      - the @vite/client carries the injected HMR config (Conan port + /preview
//        path) so HMR dials back through the proxy, not the raw dev port
//      - the HMR WebSocket upgrade routes through the gateway to Vite (101 open)
//      - a bad Origin is rejected by the gateway's Origin gate
//      - with no preview running, /preview/ returns an honest 503
//   B) a non-Vite dev server that emits X-Frame-Options + CSP frame-ancestors —
//      the proxy strips both so the page can frame in an iframe.
//
// Run: tsx scripts/test-preview-proxy.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = path.join(REPO_ROOT, "ui");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-proxy-test-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokenHeaders = { "content-type": "application/json", "x-conan-token": TOKEN };

async function startAndWait(scriptDir) {
  const put = await fetch(`${BASE}/api/cwd`, {
    method: "PUT",
    headers: tokenHeaders,
    body: JSON.stringify({ cwd: scriptDir }),
  });
  if (!put.ok) throw new Error("PUT /api/cwd failed");
  const start = await fetch(`${BASE}/api/preview/start`, {
    method: "POST",
    headers: tokenHeaders,
    body: "{}",
  });
  const startJson = await start.json();
  if (!startJson.ok) throw new Error("start failed: " + JSON.stringify(startJson));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await (await fetch(`${BASE}/api/preview/status`)).json();
    if (s.status.state === "running" && typeof s.status.port === "number") return s.status;
    if (s.status.state === "exited" || s.status.state === "error") {
      throw new Error("preview ended early: " + JSON.stringify(s.status));
    }
  }
  throw new Error("preview never reached running state");
}

async function stop() {
  await fetch(`${BASE}/api/preview/stop`, { method: "POST", headers: { "x-conan-token": TOKEN } });
  await sleep(400);
}

// Open a WS through the gateway and resolve how the handshake ended.
function wsHandshake(url, { origin, protocol } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocol, { headers: origin ? { origin } : {} });
    let firstMessage = null;
    const done = (result) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    ws.on("open", () => {
      // Give Vite a beat to send its "connected" frame, then report.
      setTimeout(() => done({ opened: true, firstMessage }), 600);
    });
    ws.on("message", (data) => {
      if (firstMessage === null) firstMessage = data.toString();
    });
    ws.on("unexpected-response", (_req, res) => done({ opened: false, status: res.statusCode }));
    ws.on("error", (err) => done({ opened: false, error: err.message }));
    setTimeout(() => done({ opened: false, error: "timeout" }), 8000);
  });
}

try {
  await import("../src/gateway/index.ts");
  await sleep(400);

  // ---- A: real Vite preview through the proxy -----------------------------
  const vite = await startAndWait(UI_DIR);
  check("Vite preview reached running state", vite.state === "running");

  // The iframe path is served same-origin WITHOUT a token (security floor).
  const page = await fetch(`${BASE}/preview/${vite.id}/`);
  const pageBody = await page.text();
  check("GET /preview/<id>/ returns 200 with no token", page.status === 200);
  check("proxied page is the Vite dev HTML", /<\/html>|@vite\/client|<div id=/i.test(pageBody));
  check(
    "no x-frame-options leaks through the proxy",
    page.headers.get("x-frame-options") === null,
  );

  // The HMR client must be configured to dial Conan's port + a /preview path.
  const client = await fetch(`${BASE}/preview/${vite.id}/@vite/client`);
  const clientJs = await client.text();
  check("@vite/client served through proxy (200)", client.status === 200);
  check("HMR client dials the Conan port (clientPort injected)", new RegExp(`hmrPort = ${PORT}\\b`).test(clientJs));
  check(
    "HMR client dials back via the /preview/<id>/ path (not the raw dev port)",
    clientJs.includes(`/preview/${vite.id}/__hmr`),
  );

  const wsTokenMatch = /wsToken = "([^"]*)"/.exec(clientJs);
  const wsToken = wsTokenMatch?.[1] ?? "";
  const hmrUrl = `ws://127.0.0.1:${PORT}/preview/${vite.id}/__hmr?token=${wsToken}`;

  // Good Origin → routes through the gateway to Vite and opens (101 + frame).
  const good = await wsHandshake(hmrUrl, { origin: ORIGIN, protocol: "vite-hmr" });
  check("HMR WS upgrade routes through the gateway and opens", good.opened === true);
  check(
    "Vite sends an HMR frame over the proxied socket",
    typeof good.firstMessage === "string" && good.firstMessage.includes("connected"),
  );

  // Bad Origin → the gateway's Origin gate rejects before proxying.
  const bad = await wsHandshake(hmrUrl, { origin: "http://evil.example", protocol: "vite-hmr" });
  check("HMR WS upgrade with a disallowed Origin is rejected", bad.opened === false);

  await stop();

  // With nothing running, the proxy returns an honest 503 (not a thrown error).
  const noPrev = await fetch(`${BASE}/preview/${vite.id}/`);
  check("GET /preview/<id>/ with no running preview returns 503", noPrev.status === 503);

  // ---- B: framing-header strip on a non-Vite dev server -------------------
  const proj = path.join(tmp, "framed-app");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "framed-app", scripts: { dev: "node server.mjs" } }),
  );
  fs.writeFileSync(
    path.join(proj, "server.mjs"),
    [
      "import http from 'node:http';",
      "const srv = http.createServer((req, res) => {",
      "  res.setHeader('X-Frame-Options', 'DENY');",
      "  res.setHeader('Content-Security-Policy', \"default-src 'self'; frame-ancestors 'none'\");",
      "  res.end('framed app ok');",
      "});",
      "srv.listen(0, '127.0.0.1', () => {",
      "  console.log(`  Local:   http://localhost:${srv.address().port}/`);",
      "});",
    ].join("\n"),
  );

  const framed = await startAndWait(proj);
  check("non-Vite preview scraped a bound port from stdout", typeof framed.port === "number");
  const framedRes = await fetch(`${BASE}/preview/${framed.id}/`);
  await framedRes.text();
  check("proxy strips X-Frame-Options", framedRes.headers.get("x-frame-options") === null);
  const csp = framedRes.headers.get("content-security-policy") ?? "";
  check("proxy strips frame-ancestors from CSP", !/frame-ancestors/i.test(csp));
  check("proxy keeps the rest of the CSP intact", /default-src/i.test(csp));
  await stop();
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
