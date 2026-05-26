// US-045 test: doctor + version/update status.
// Exercises the pure status read against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR / CONAN_CLAUDE_JSON), the bounded `claude doctor` shell-out
// (via a fake CONAN_CLAUDE_BIN), then the gateway route end-to-end:
//   - installedVersion comes from sessions/<pid>.json; latestVersion from the
//     newest changelog entry; updateAvailable = latest > installed (semver)
//   - autoUpdates / autoUpdatesProtectedForNative read from ~/.claude.json
//   - runDoctor() returns ok+summary on clean output; degrades to ok:false on
//     empty output and on a missing binary
//   - GET /api/claude/doctor is read-only (health null); ?check=1 is token-gated
//
// Run: tsx scripts/test-doctor.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-doctor-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const claudeJson = path.join(tmp, "dot-claude.json");
fs.mkdirSync(path.join(claudeDir, "cache"), { recursive: true });
fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_CLAUDE_JSON = claudeJson;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
// The fake `claude` binary the route's runDoctor() resolves (module-level const,
// so it must be set before the doctor module is first imported).
const fakeBin = path.join(tmp, "fake-claude");
process.env.CONAN_CLAUDE_BIN = fakeBin;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Changelog newest-first: latest is 2.1.151, installed will be 2.1.150 → update.
fs.writeFileSync(
  path.join(claudeDir, "cache", "changelog.md"),
  `# Changelog\n\n## 2.1.151\n\n- Shiny new thing\n\n## 2.1.150\n\n- Older thing\n`,
);
fs.writeFileSync(
  claudeJson,
  JSON.stringify({
    lastReleaseNotesSeen: "2.1.150",
    autoUpdates: false,
    autoUpdatesProtectedForNative: true,
  }),
);
fs.writeFileSync(
  path.join(claudeDir, "sessions", "999.json"),
  JSON.stringify({ pid: 999, sessionId: "abc", version: "2.1.150" }),
);

// A fake `claude` binary: `claude doctor` prints a health summary and exits 0.
fs.writeFileSync(
  fakeBin,
  `#!/usr/bin/env bash\nif [ "$1" = "doctor" ]; then echo "Auto-updater: healthy"; echo "Install: native"; exit 0; fi\nexit 1\n`,
);
fs.chmodSync(fakeBin, 0o755);

try {
  const mod = await import("../src/doctor/index.ts");

  // --- pure status --------------------------------------------------------
  const st = mod.readDoctorStatus();
  check("installedVersion from sessions/<pid>.json", st.installedVersion === "2.1.150");
  check("latestVersion from newest changelog entry", st.latestVersion === "2.1.151");
  check("updateAvailable true (2.1.151 > 2.1.150)", st.updateAvailable === true);
  check("autoUpdates read as false", st.autoUpdates === false);
  check(
    "autoUpdatesProtectedForNative read as true",
    st.autoUpdatesProtectedForNative === true,
  );
  check("changelogLastFetched is epoch ms", typeof st.changelogLastFetched === "number");

  // No-update case: installed == latest.
  fs.writeFileSync(
    path.join(claudeDir, "sessions", "999.json"),
    JSON.stringify({ pid: 999, version: "2.1.151" }),
  );
  check("updateAvailable false when installed == latest", mod.readDoctorStatus().updateAvailable === false);
  // restore the update case
  fs.writeFileSync(
    path.join(claudeDir, "sessions", "999.json"),
    JSON.stringify({ pid: 999, version: "2.1.150" }),
  );

  // --- runDoctor: clean output -------------------------------------------
  const ok = await mod.runDoctor({ bin: fakeBin });
  check("runDoctor ran", ok.ran === true);
  check("runDoctor ok on clean output", ok.ok === true);
  check("runDoctor summary captured", typeof ok.summary === "string" && ok.summary.includes("healthy"));

  // --- runDoctor: missing binary degrades gracefully ----------------------
  const missing = await mod.runDoctor({ bin: path.join(tmp, "nope-binary") });
  check("runDoctor missing binary → ran true", missing.ran === true);
  check("runDoctor missing binary → ok false", missing.ok === false);
  check("runDoctor missing binary → error set", typeof missing.error === "string" && missing.error.length > 0);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const base = await (await fetch(`${BASE}/api/claude/doctor`)).json();
  check("GET /doctor reports installedVersion", base.installedVersion === "2.1.150");
  check("GET /doctor reports updateAvailable", base.updateAvailable === true);
  check("GET /doctor health null without ?check", base.health === null);

  const unauth = await fetch(`${BASE}/api/claude/doctor?check=1`);
  check("GET /doctor?check=1 token-gated (401 unauth)", unauth.status === 401);

  const authed = await (
    await fetch(`${BASE}/api/claude/doctor?check=1`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check("GET /doctor?check=1 runs doctor (health present)", authed.health && authed.health.ran === true);
  check("GET /doctor?check=1 health ok", authed.health.ok === true);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
