// US-002 test: GET /api/claude/stats — normalize ~/.claude/stats-cache.json.
// First exercises the pure helpers (zero-fill, streaks, full normalize) against
// crafted shapes, then boots the real gateway and drives the endpoint with the
// stats path pointed at a fixture, asserting the contiguous calendar + computed
// stats round-trip and that a missing file degrades to a safe empty shape.
//
// Run: tsx scripts/test-stats.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-stats-test-"));
const dataDir = path.join(tmp, "data");
// Point the gateway's HOME at the tmp dir so readStats() resolves
// <HOME>/.claude/stats-cache.json to our fixture.
const fakeHome = path.join(tmp, "home");
const claudeDir = path.join(fakeHome, ".claude");
fs.mkdirSync(claudeDir, { recursive: true });

const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.HOME = fakeHome;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // --- pure helpers -------------------------------------------------------
  const { zeroFillDailyActivity, computeStreaks, normalizeStats, readStats } =
    await import("../src/stats/index.ts");

  // Zero-fill bridges the gap between 01-01 and 01-04 (4 contiguous days).
  const filled = zeroFillDailyActivity([
    { date: "2026-01-04", messageCount: 5, sessionCount: 1, toolCallCount: 2 },
    { date: "2026-01-01", messageCount: 9, sessionCount: 2, toolCallCount: 3 },
  ]);
  check("zero-fill produces a contiguous range", filled.length === 4);
  check("zero-fill is date-sorted ascending", filled[0].date === "2026-01-01");
  check(
    "zero-fill inserts empty days in the gap",
    filled[1].date === "2026-01-02" && filled[1].messageCount === 0,
  );
  check("zero-fill preserves real days", filled[3].messageCount === 5);

  // lastComputedDate extends trailing idle days.
  const filledTail = zeroFillDailyActivity(
    [{ date: "2026-01-01", messageCount: 1, sessionCount: 1, toolCallCount: 1 }],
    "2026-01-03",
  );
  check("lastComputedDate extends the range", filledTail.length === 3);
  check(
    "trailing days are idle",
    filledTail[2].date === "2026-01-03" && filledTail[2].messageCount === 0,
  );

  // empty input -> empty array.
  check("empty dailyActivity -> []", zeroFillDailyActivity([]).length === 0);

  // Streaks: active,active,idle,active -> longest 2, current 1.
  const streaks = computeStreaks([
    { date: "d1", messageCount: 1, sessionCount: 0, toolCallCount: 0 },
    { date: "d2", messageCount: 1, sessionCount: 0, toolCallCount: 0 },
    { date: "d3", messageCount: 0, sessionCount: 0, toolCallCount: 0 },
    { date: "d4", messageCount: 1, sessionCount: 0, toolCallCount: 0 },
  ]);
  check("longest streak counts the longest active run", streaks.longestStreak === 2);
  check("current streak is the trailing active run", streaks.currentStreak === 1);

  const streaksIdleTail = computeStreaks([
    { date: "d1", messageCount: 1, sessionCount: 0, toolCallCount: 0 },
    { date: "d2", messageCount: 0, sessionCount: 0, toolCallCount: 0 },
  ]);
  check("idle last day -> current streak 0", streaksIdleTail.currentStreak === 0);

  // Full normalize.
  const norm = normalizeStats({
    dailyActivity: [
      { date: "2026-01-01", messageCount: 10, sessionCount: 1, toolCallCount: 4 },
      { date: "2026-01-02", messageCount: 5, sessionCount: 1, toolCallCount: 2 },
    ],
    modelUsage: {
      "claude-opus-4-7": {
        inputTokens: 1000,
        outputTokens: 9000,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
      },
      "claude-haiku-4-5": { inputTokens: 100, outputTokens: 50 },
    },
    hourCounts: { "9": 3, "17": 40, "22": 12 },
    totalSessions: 351,
    totalMessages: 63046,
    firstSessionDate: "2025-12-31T03:41:58.536Z",
    lastComputedDate: "2026-01-02",
  });
  check("totalTokens sums input+output across models", norm.totalTokens === 10150);
  check(
    "totalTokensWithCache adds cache tokens",
    norm.totalTokensWithCache === 10150 + 600,
  );
  check("activeDays counts days with activity", norm.activeDays === 2);
  check("favoriteModel is the top input+output model", norm.favoriteModel === "claude-opus-4-7");
  check("favoriteHour is the busiest hour", norm.favoriteHour === 17);
  check("firstSessionDate passed through", norm.firstSessionDate === "2025-12-31T03:41:58.536Z");
  check("totalSessions/totalMessages passed through", norm.totalSessions === 351 && norm.totalMessages === 63046);
  check("hasData true for populated stats", norm.hasData === true);

  // Missing file -> safe empty shape (no throw).
  const missing = readStats(path.join(tmp, "does-not-exist.json"));
  check("missing file -> hasData false", missing.hasData === false);
  check("missing file -> empty dailyActivity", missing.dailyActivity.length === 0);
  check("missing file -> zeroed counters", missing.totalSessions === 0 && missing.totalTokens === 0);

  // --- gateway round-trip -------------------------------------------------
  // Write a fixture at <fakeHome>/.claude/stats-cache.json, then GET the route.
  const fixture = {
    version: 3,
    lastComputedDate: "2026-05-03",
    dailyActivity: [
      { date: "2026-05-01", messageCount: 20, sessionCount: 2, toolCallCount: 8 },
      { date: "2026-05-03", messageCount: 7, sessionCount: 1, toolCallCount: 3 },
    ],
    modelUsage: {
      "claude-opus-4-7": { inputTokens: 2000, outputTokens: 8000 },
    },
    hourCounts: { "14": 9, "15": 22 },
    totalSessions: 42,
    totalMessages: 999,
    firstSessionDate: "2026-04-01T00:00:00.000Z",
  };
  fs.writeFileSync(
    path.join(claudeDir, "stats-cache.json"),
    JSON.stringify(fixture),
  );

  await import("../src/gateway/index.ts");
  await sleep(300);

  const stats = await (await fetch(`${BASE}/api/claude/stats`)).json();
  check("endpoint returns contiguous calendar (3 days)", stats.dailyActivity.length === 3);
  check(
    "endpoint zero-fills the gap day",
    stats.dailyActivity[1].date === "2026-05-02" && stats.dailyActivity[1].messageCount === 0,
  );
  check("endpoint totalTokens computed", stats.totalTokens === 10000);
  check("endpoint activeDays computed", stats.activeDays === 2);
  check("endpoint favoriteModel computed", stats.favoriteModel === "claude-opus-4-7");
  check("endpoint favoriteHour computed", stats.favoriteHour === 15);
  check("endpoint totalSessions passthrough", stats.totalSessions === 42);
  check("endpoint hasData true", stats.hasData === true);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
