// US-019 test: toolbar cwd → active working-directory picker. Exercises the
// pure cwd module (validation, listing, persistence, change notifications) and
// then the gateway routes end-to-end:
//   - GET /api/config + GET /api/cwd report the active cwd (default = repo root)
//   - PUT /api/cwd is token-gated and rejects invalid/inaccessible paths
//   - PUT /api/cwd to a real directory updates the active cwd and persists it
//   - GET /api/fs/dirs lists subdirectories (token-gated)
//   - the Tasks reader follows the active cwd (prd.json under the new dir)
//
// Run: tsx scripts/test-cwd.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-cwd-test-"));
const dataDir = path.join(tmp, "data");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
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

// A project dir the picker can switch to, with its own prd.json.
const projDir = path.join(tmp, "other-project");
const subDir = path.join(projDir, "sub");
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(
  path.join(projDir, "prd.json"),
  JSON.stringify({
    project: "OtherProj",
    branchName: "x",
    userStories: [
      { id: "A-1", title: "alpha", priority: 1, passes: true },
      { id: "A-2", title: "beta", priority: 2, passes: false },
    ],
  }),
);

try {
  // --- pure module --------------------------------------------------------
  const cwdMod = await import("../src/cwd/index.ts");
  const { PACKAGE_ROOT } = await import("../src/paths.ts");

  check("default active cwd is the repo root", cwdMod.getActiveCwd() === PACKAGE_ROOT);

  let changed = null;
  const unsub = cwdMod.onCwdChange((c) => {
    changed = c;
  });

  check(
    "setActiveCwd rejects a non-existent path",
    cwdMod.setActiveCwd(path.join(tmp, "nope")).ok === false,
  );
  check(
    "setActiveCwd rejects a file (not a directory)",
    cwdMod.setActiveCwd(path.join(projDir, "prd.json")).ok === false,
  );
  check("setActiveCwd rejects empty input", cwdMod.setActiveCwd("").ok === false);

  const set = cwdMod.setActiveCwd(projDir);
  check("setActiveCwd accepts a real directory", set.ok === true && set.cwd === projDir);
  check("getActiveCwd reflects the change", cwdMod.getActiveCwd() === projDir);
  check("onCwdChange listener fired with the new cwd", changed === projDir);
  unsub();

  const listing = cwdMod.listDirs(projDir);
  check(
    "listDirs returns the subdirectory",
    listing.entries.some((e) => e.name === "sub" && e.path === subDir),
  );
  check("listDirs exposes the parent", listing.parent === tmp);
  check(
    "listDirs on a bad path degrades with an error",
    cwdMod.listDirs(path.join(tmp, "missing")).error !== undefined,
  );

  // Reset to repo root so the gateway boots with the documented default.
  cwdMod.setActiveCwd(PACKAGE_ROOT);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const config = await (await fetch(`${BASE}/api/config`)).json();
  check("GET /api/config reports the active cwd", config.cwd === PACKAGE_ROOT);

  const cwd0 = await (await fetch(`${BASE}/api/cwd`)).json();
  check("GET /api/cwd default = repo root", cwd0.cwd === PACKAGE_ROOT && cwd0.default === PACKAGE_ROOT);

  // PUT without a token is rejected.
  const noAuth = await fetch(`${BASE}/api/cwd`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projDir }),
  });
  check("PUT /api/cwd without token is 401", noAuth.status === 401);

  // PUT an invalid path is a clear 400.
  const bad = await fetch(`${BASE}/api/cwd`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ cwd: path.join(tmp, "does-not-exist") }),
  });
  const badJson = await bad.json();
  check("PUT /api/cwd invalid path -> 400 with message", bad.status === 400 && typeof badJson.error === "string");

  // PUT a valid path switches the active cwd.
  const ok = await fetch(`${BASE}/api/cwd`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ cwd: projDir }),
  });
  const okJson = await ok.json();
  check("PUT /api/cwd valid path -> ok + new cwd", ok.ok && okJson.cwd === projDir);

  const cwd1 = await (await fetch(`${BASE}/api/cwd`)).json();
  check("active cwd reflects the PUT", cwd1.cwd === projDir);

  // /api/fs/dirs is token-gated and lists subdirectories.
  const dirsNoAuth = await fetch(`${BASE}/api/fs/dirs?path=${encodeURIComponent(projDir)}`);
  check("GET /api/fs/dirs without token is 401", dirsNoAuth.status === 401);

  const dirs = await (
    await fetch(`${BASE}/api/fs/dirs?path=${encodeURIComponent(projDir)}`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  check("GET /api/fs/dirs lists the subdirectory", dirs.entries.some((e) => e.name === "sub"));

  // The Tasks reader follows the active cwd: prd.json now resolves under projDir.
  await sleep(300); // let the cwd-change watcher re-scope
  const tasks = await (await fetch(`${BASE}/api/tasks`)).json();
  check("Tasks reader followed the new cwd (project name)", tasks.project === "OtherProj");
  check("Tasks reader followed the new cwd (current story)", tasks.currentId === "A-2");

  // The chosen cwd was persisted to the data dir.
  const persisted = fs.readFileSync(path.join(dataDir, "active-cwd"), "utf8").trim();
  check("active cwd persisted to .data/active-cwd", persisted === projDir);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
