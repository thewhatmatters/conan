// US-010 test: per-project metrics — read ~/.claude.json projects[<cwd>] and
// return last-session cost/tokens/lines/model split.
// Exercises the pure module against a hermetic fake ~/.claude.json (via
// CONAN_CLAUDE_JSON), then the gateway route end-to-end:
//   - known project → found:true with cost/tokens/lines/duration/sessionId
//   - lastModelUsage parsed into a per-model array, costliest first
//   - unknown project / missing file / malformed JSON → safe found:false shape
//   - cwd param honored; ?cwd defaults to the active cwd
//
// Run: tsx scripts/test-project-metrics.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-project-metrics-test-"));
const claudeJson = path.join(tmp, "dot-claude.json");

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const knownCwd = path.join(tmp, "repos", "alpha");
const activeCwd = path.join(tmp, "repos", "active");
fs.mkdirSync(knownCwd, { recursive: true });
fs.mkdirSync(activeCwd, { recursive: true });

process.env.CONAN_CLAUDE_JSON = claudeJson;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.CONAN_DATA_DIR, { recursive: true });
// Pin the active cwd so the no-param path is deterministic.
fs.writeFileSync(path.join(process.env.CONAN_DATA_DIR, "active-cwd"), activeCwd);
process.env.CONAN_AUTH_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed ~/.claude.json with two projects: a rich `alpha` entry and a sparse
// `active` entry (no modelUsage). An unrelated project guards against leakage.
fs.writeFileSync(
  claudeJson,
  JSON.stringify({
    projects: {
      [knownCwd]: {
        lastCost: 6.99,
        lastTotalInputTokens: 1244,
        lastTotalOutputTokens: 17812,
        lastTotalCacheCreationInputTokens: 492925,
        lastTotalCacheReadInputTokens: 6922359,
        lastLinesAdded: 120,
        lastLinesRemoved: 34,
        lastDuration: 3022,
        lastSessionId: "65e76490-43a4-44ec-b2c9-97cdb12930bc",
        lastModelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 268401,
            outputTokens: 7933,
            cacheReadInputTokens: 618872,
            cacheCreationInputTokens: 93201,
            webSearchRequests: 0,
            costUSD: 0.48,
          },
          "claude-opus-4-5-20251101": {
            inputTokens: 1244,
            outputTokens: 17812,
            cacheReadInputTokens: 6922359,
            cacheCreationInputTokens: 492925,
            webSearchRequests: 2,
            costUSD: 6.99,
          },
        },
      },
      [activeCwd]: {
        lastCost: 0.12,
        lastSessionId: "aaaa1111-2222-3333-4444-555566667777",
      },
    },
  }),
);

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/project-metrics/index.ts");

  const a = mod.readProjectMetrics(knownCwd);
  check("known project → found:true", a.found === true);
  check("carries cost/tokens/lines/duration", a.lastCost === 6.99 && a.lastTotalInputTokens === 1244 && a.lastLinesAdded === 120 && a.lastDuration === 3022);
  check("carries lastSessionId", a.lastSessionId === "65e76490-43a4-44ec-b2c9-97cdb12930bc");
  check("model usage parsed (2 models)", a.lastModelUsage.length === 2);
  check(
    "model usage sorted costliest-first",
    a.lastModelUsage[0].model === "claude-opus-4-5-20251101" && a.lastModelUsage[0].costUSD === 6.99,
  );
  check("model usage carries token split", a.lastModelUsage[1].inputTokens === 268401 && a.lastModelUsage[1].model === "claude-haiku-4-5-20251001");

  // sparse entry: present but no modelUsage; missing numerics → null
  const s = mod.readProjectMetrics(activeCwd);
  check("sparse project found with empty modelUsage", s.found === true && s.lastModelUsage.length === 0);
  check("missing numeric fields → null", s.lastTotalInputTokens === null && s.lastLinesAdded === null);

  // no-arg → active cwd
  const def = mod.readProjectMetrics();
  check("defaults to active cwd", def.cwd === path.resolve(activeCwd) && def.lastCost === 0.12);

  // unknown project → found:false, nulls
  const u = mod.readProjectMetrics(path.join(tmp, "repos", "nope"));
  check("unknown project → found:false", u.found === false && u.lastCost === null && u.lastModelUsage.length === 0);

  // missing file → safe shape
  const m = mod.readProjectMetrics(knownCwd, { claudeJsonPath: path.join(tmp, "absent.json") });
  check("missing ~/.claude.json → found:false", m.found === false);

  // malformed JSON → safe shape
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, "{ not json");
  check("malformed JSON → found:false", mod.readProjectMetrics(knownCwd, { claudeJsonPath: bad }).found === false);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/project-metrics?cwd=${encodeURIComponent(knownCwd)}`)).json();
  check("GET ?cwd= returns the project's metrics", g.found === true && g.lastCost === 6.99 && g.lastModelUsage.length === 2);

  const gd = await (await fetch(`${BASE}/api/claude/project-metrics`)).json();
  check("GET without cwd → active cwd", gd.cwd === path.resolve(activeCwd) && gd.lastCost === 0.12);

  const gu = await (await fetch(`${BASE}/api/claude/project-metrics?cwd=${encodeURIComponent(path.join(tmp, "nope"))}`)).json();
  check("GET unknown project → found:false (no throw)", gu.found === false);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
