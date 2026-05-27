// US-007 test: the gateway Origin allowlist accepts the Tauri webview origin
// (tauri://localhost + http/https tauri.localhost) so the desktop app's app +
// terminal WS upgrades work, while the CVE-2025-52882 floor is unchanged —
// unknown origins are still rejected and the loopback/Vite defaults survive.
//
// Run: tsx scripts/test-tauri-origin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

// Isolate the data dir so importing auth.ts doesn't touch the real token file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-tauri-origin-"));
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = "tauri-origin-test-token";
process.env.CONAN_PORT = "3747";

try {
  const { verifyUpgradeOrigin } = await import("../src/gateway/auth.ts");

  const withOrigin = (origin) =>
    verifyUpgradeOrigin({ headers: { origin } });

  // The three Tauri webview origins must be allowed.
  check("tauri://localhost allowed", withOrigin("tauri://localhost").ok === true);
  check("http://tauri.localhost allowed", withOrigin("http://tauri.localhost").ok === true);
  check("https://tauri.localhost allowed", withOrigin("https://tauri.localhost").ok === true);

  // The pre-existing loopback + Vite defaults survive.
  check("http://127.0.0.1:3747 still allowed", withOrigin("http://127.0.0.1:3747").ok === true);
  check("http://localhost:5173 still allowed", withOrigin("http://localhost:5173").ok === true);

  // The CVE-2025-52882 floor is intact: unknown origins rejected.
  check("bogus origin rejected", withOrigin("https://evil.example.com").ok === false);
  check("look-alike tauri origin rejected", withOrigin("tauri://evil").ok === false);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
