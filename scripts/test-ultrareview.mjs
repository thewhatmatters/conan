// US-046 test: ultrareview trigger + findings panel.
// Exercises the in-memory run lifecycle against a fake `claude` binary (via
// CONAN_CLAUDE_BIN) that streams a review then exits, plus the gateway routes:
//   - startUltrareview streams stdout into the run, parses a findings count, and
//     lands the run in status:'done' on a clean exit
//   - a non-zero exit lands status:'error' with a reason; a missing binary too
//   - parseFindingsCount picks the last "<n> findings/issues" summary
//   - GET /api/claude/ultrareview is read-only; POST start + POST stop are
//     token-gated (401 without the token); a second concurrent start is refused
//
// Run: tsx scripts/test-ultrareview.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-ultrareview-test-"));
const PORT = 3970 + Math.floor(Math.random() * 25);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);

process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

// A fake `claude` binary: `claude ultrareview` streams a review and exits 0;
// anything else exits 1 (so a wrong invocation is a clean failure).
const okBin = path.join(tmp, "fake-claude-ok");
fs.writeFileSync(
  okBin,
  `#!/usr/bin/env bash
if [ "$1" = "ultrareview" ]; then
  echo "Reviewing $2"
  echo "src/foo.ts:10 possible null deref"
  sleep 0.1
  echo "Found 2 findings"
  exit 0
fi
exit 1
`,
);
fs.chmodSync(okBin, 0o755);

// The gateway's start route uses CONAN_CLAUDE_BIN (captured at module import),
// so it must be set before the ultrareview module is first imported below.
process.env.CONAN_CLAUDE_BIN = okBin;

// A fake `claude` that fails the review (non-zero exit).
const failBin = path.join(tmp, "fake-claude-fail");
fs.writeFileSync(failBin, `#!/usr/bin/env bash\necho "boom" >&2\nexit 3\n`);
fs.chmodSync(failBin, 0o755);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
};

try {
  const mod = await import("../src/ultrareview/index.ts");

  // --- parseFindingsCount (pure) -----------------------------------------
  check("parseFindingsCount picks last summary", mod.parseFindingsCount("1 issue\nFound 7 findings") === 7);
  check("parseFindingsCount null when absent", mod.parseFindingsCount("nothing here") === null);

  // --- run lifecycle: clean exit -----------------------------------------
  mod._resetForTest();
  check("readUltrareview null before any run", mod.readUltrareview().run === null);
  const started = mod.startUltrareview({ bin: okBin, pr: "42" });
  check("startUltrareview ok", started.ok === true);
  check("start sets status running", started.run.status === "running");
  check("start records PR target", started.run.target.kind === "pr" && started.run.target.ref === "42");
  // A second start while running is refused.
  const dup = mod.startUltrareview({ bin: okBin });
  check("concurrent start refused", dup.ok === false);

  const finished = await waitFor(() => mod.readUltrareview().run?.status === "done");
  check("run reaches status done", finished);
  const done = mod.readUltrareview().run;
  check("output captured (streamed)", typeof done.output === "string" && done.output.includes("possible null deref"));
  check("findingsCount parsed from output", done.findingsCount === 2);
  check("exitCode 0 on clean run", done.exitCode === 0);

  // --- run lifecycle: non-zero exit --------------------------------------
  mod._resetForTest();
  mod.startUltrareview({ bin: failBin });
  const errored = await waitFor(() => mod.readUltrareview().run?.status === "error");
  check("non-zero exit → status error", errored);
  check("error reason set", typeof mod.readUltrareview().run.error === "string");

  // --- missing binary degrades -------------------------------------------
  mod._resetForTest();
  mod.startUltrareview({ bin: path.join(tmp, "nope-binary") });
  const missing = await waitFor(() => mod.readUltrareview().run?.status === "error");
  check("missing binary → status error", missing);

  // --- gateway round-trip -------------------------------------------------
  mod._resetForTest();
  await import("../src/gateway/index.ts");
  await sleep(300);

  const snap = await (await fetch(`${BASE}/api/claude/ultrareview`)).json();
  check("GET /ultrareview read-only (run null initially)", snap.run === null);

  const unauth = await fetch(`${BASE}/api/claude/ultrareview`, { method: "POST" });
  check("POST /ultrareview token-gated (401)", unauth.status === 401);

  const startRes = await (
    await fetch(`${BASE}/api/claude/ultrareview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": TOKEN },
      body: JSON.stringify({}),
    })
  ).json();
  check("POST start returns run", startRes.ok === true && startRes.run.status === "running");
  check("start defaults to current-branch target", startRes.run.target.kind === "branch");

  const ranToDone = await waitFor(async () => {
    const s = await (await fetch(`${BASE}/api/claude/ultrareview`)).json();
    return s.run?.status === "done";
  });
  check("GET reflects completed run", ranToDone);

  const stopUnauth = await fetch(`${BASE}/api/claude/ultrareview/stop`, { method: "POST" });
  check("POST stop token-gated (401)", stopUnauth.status === 401);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
