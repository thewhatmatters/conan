// US-024 test: opt-in remote access over TLS (wss://) with token auth.
//
// Two parts:
//  1. Pure config/guard logic in src/gateway/tls.ts — resolveTlsConfig is off by
//     default, throws on a half-configured pair, and assertRemoteSafe refuses a
//     non-loopback bind without TLS (so a raw/cleartext port is never exposed).
//  2. A real boot: generate a self-signed cert, start the gateway in TLS mode,
//     and prove the dashboard + both WebSockets are served over https/wss behind
//     the existing token + Origin checks (the terminal pty has no separate raw
//     port — it rides the same authenticated wss upgrade).
//
// Run: tsx scripts/test-tls.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-tls-test-"));

// --- part 1: pure config + guard logic (no server) -----------------------
const { resolveTlsConfig, assertRemoteSafe, isLoopbackHost } = await import(
  "../src/gateway/tls.ts"
);

check("remote mode OFF by default (no env)", resolveTlsConfig({}).enabled === false);

let threw = false;
try {
  resolveTlsConfig({ CONAN_TLS_CERT: "/x/cert.pem" }); // key missing
} catch {
  threw = true;
}
check("half-configured TLS (cert only) throws", threw);

check("isLoopbackHost true for 127.0.0.1/localhost/::1", isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost") && isLoopbackHost("::1"));
check("isLoopbackHost false for 0.0.0.0", isLoopbackHost("0.0.0.0") === false);

// Loopback without TLS is fine; non-loopback without TLS is refused.
let safeOk = true;
try {
  assertRemoteSafe("127.0.0.1", { enabled: false });
} catch {
  safeOk = false;
}
check("loopback bind allowed without TLS", safeOk);

let refused = false;
try {
  assertRemoteSafe("0.0.0.0", { enabled: false });
} catch {
  refused = true;
}
check("non-loopback bind WITHOUT TLS is refused (no cleartext exposure)", refused);

let allowedWithTls = true;
try {
  assertRemoteSafe("0.0.0.0", { enabled: true, options: {} });
} catch {
  allowedWithTls = false;
}
check("non-loopback bind allowed WITH TLS", allowedWithTls);

// --- part 2: real TLS boot -----------------------------------------------
// Generate a throwaway self-signed cert/key for 127.0.0.1.
const certPath = path.join(tmp, "cert.pem");
const keyPath = path.join(tmp, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath,
  "-days", "1", "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1",
]);

const TOKEN = "tls-test-" + Math.random().toString(36).slice(2, 10);
const PORT = 3900 + Math.floor(Math.random() * 80);
const ORIGIN = `https://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_SETTINGS_PATH = path.join(tmp, "settings.json");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.CONAN_TLS_CERT = certPath;
process.env.CONAN_TLS_KEY = keyPath;

// https GET that accepts the self-signed cert.
function httpsGet(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "GET", rejectUnauthorized: false, headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// Raw WS upgrade over TLS, returning the HTTP status line (101 = accepted).
function wsUpgradeStatus(pathname, token, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    // ws requires a 16-byte base64 key, else it 400s before our auth check.
    const key = crypto.randomBytes(16).toString("base64");
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
      Origin: origin,
    };
    const req = https.request({
      host: "127.0.0.1", port: PORT,
      path: token ? `${pathname}?token=${token}` : pathname,
      method: "GET", rejectUnauthorized: false, headers,
    });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on("upgrade", (res) => { res.socket.destroy(); done(101); });
    req.on("response", (res) => { res.socket.destroy(); done(res.statusCode); });
    req.on("error", reject);
    req.end();
    setTimeout(() => done(0), 2000);
  });
}

try {
  await import("../src/gateway/index.ts");
  await sleep(400);

  const health = await httpsGet("/api/health");
  check("dashboard served over HTTPS (GET /api/health = 200)", health.status === 200);
  check("health body reports the running port", JSON.parse(health.body).port === PORT);

  const config = await httpsGet("/api/config");
  check("SPA bootstrap token readable over https", JSON.parse(config.body).token === TOKEN);

  // App WS over wss:// — auth enforced on the upgrade.
  check("app wss upgrade accepted with token (101)", (await wsUpgradeStatus("/ws", TOKEN)) === 101);
  check("app wss upgrade rejected without token (401)", (await wsUpgradeStatus("/ws", null)) === 401);

  // Terminal pty rides the SAME authenticated wss upgrade — no raw shell port.
  check("terminal wss upgrade accepted with token (101)", (await wsUpgradeStatus("/ws/terminal", TOKEN)) === 101);
  check("terminal wss upgrade rejected without token (401)", (await wsUpgradeStatus("/ws/terminal", null)) === 401);

  // Cross-origin wss is rejected even with a valid token (Origin allowlist).
  check(
    "wss upgrade rejected from a foreign origin",
    (await wsUpgradeStatus("/ws", TOKEN, "https://evil.example.com")) === 401,
  );
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
