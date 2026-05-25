// US-030 test: usage monitor (cost/tokens today + rate-limited state + reset
// time). First exercises the pure parsing helpers against the shapes a
// retry/limit payload can take, then boots the real gateway against an isolated
// DB, seeds events, and drives GET /api/claude/usage:
//   - costToday / tokensToday aggregate from session + result rows
//   - a rate-limit api_retry sets rateLimited + a parsed resetAt
//   - a later successful event clears the rate-limited state
//
// Run: tsx scripts/test-usage.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-usage-test-"));
const dataDir = path.join(tmp, "data");
const settingsPath = path.join(tmp, "settings.json");
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_SETTINGS_PATH = settingsPath;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // --- pure helpers -------------------------------------------------------
  const { isRateLimitPayload, parseResetAt } = await import(
    "../src/usage/index.ts"
  );

  check(
    "rate_limit_error type detected",
    isRateLimitPayload({ error: { type: "rate_limit_error" } }) === true,
  );
  check(
    "nested error.error rate_limit_error detected",
    isRateLimitPayload({ error: { error: { type: "rate_limit_error" } } }) ===
      true,
  );
  check("HTTP 429 status detected", isRateLimitPayload({ status: 429 }) === true);
  check(
    "textual 'rate limit' detected",
    isRateLimitPayload({ message: "You hit your usage limit" }) === true,
  );
  check(
    "ordinary overloaded retry is NOT a rate limit",
    isRateLimitPayload({ error: { type: "overloaded_error" }, attempt: 2 }) ===
      false,
  );

  const t0 = Date.parse("2026-05-25T12:00:00Z");
  check(
    "retry_after seconds -> eventTs + delay",
    parseResetAt({ retry_after: 60 }, t0) === t0 + 60_000,
  );
  check(
    "unix-seconds reset field -> ms",
    parseResetAt({ reset_at: Math.floor((t0 + 120_000) / 1000) }, t0) ===
      Math.floor((t0 + 120_000) / 1000) * 1000,
  );
  check(
    "ISO reset string parsed",
    parseResetAt({ resetsAt: "2026-05-25T12:30:00Z" }, t0) ===
      Date.parse("2026-05-25T12:30:00Z"),
  );
  check(
    "unified-reset header (nested) parsed",
    parseResetAt(
      { headers: { "anthropic-ratelimit-unified-reset": Math.floor((t0 + 300_000) / 1000) } },
      t0,
    ) === Math.floor((t0 + 300_000) / 1000) * 1000,
  );
  check(
    "no reset info -> null",
    parseResetAt({ error: { type: "rate_limit_error" } }, t0) === null,
  );

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const { getDb } = await import("../src/db/index.ts");
  const db = getDb();
  const now = Date.now();

  // Two sessions active today with known cost.
  const upSession = db.prepare(
    `INSERT INTO session (id, model, status, created_at, last_activity, total_cost_usd)
       VALUES (?, 'claude-opus-4-7', 'running', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET total_cost_usd = excluded.total_cost_usd,
                                   last_activity = excluded.last_activity`,
  );
  upSession.run("sess-a", now - 3_600_000, now, 1.25);
  upSession.run("sess-b", now - 3_600_000, now, 0.75); // costToday = 2.00

  const insEvent = db.prepare(
    `INSERT INTO event (session_id, hook_event_name, stream_type, tool_name, payload, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Result rows -> tokensToday = 1200.
  insEvent.run("sess-a", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 800 } }), now - 60_000);
  insEvent.run("sess-b", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 400 } }), now - 50_000);

  let usage = await (await fetch(`${BASE}/api/claude/usage`)).json();
  check("costToday aggregates session cost", Math.abs(usage.costToday - 2.0) < 1e-6);
  check("tokensToday sums result output tokens", usage.tokensToday === 1200);
  check("not rate-limited with no retry events", usage.rateLimited === false);
  check("hasData true once usage recorded", usage.hasData === true);

  // A rate-limit retry with a 90s reset -> rateLimited + resetAt in the future.
  const retryTs = now - 10_000;
  insEvent.run(
    "sess-a",
    null,
    "system/api_retry",
    null,
    JSON.stringify({ type: "system", subtype: "api_retry", error: { type: "rate_limit_error" }, retry_after: 90 }),
    retryTs,
  );
  usage = await (await fetch(`${BASE}/api/claude/usage`)).json();
  check("rate-limit retry sets rateLimited", usage.rateLimited === true);
  check(
    "resetAt parsed from retry_after",
    usage.resetAt === retryTs + 90_000,
  );

  // A later successful event on the same session clears the limited state.
  insEvent.run("sess-a", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 50 } }), now);
  usage = await (await fetch(`${BASE}/api/claude/usage`)).json();
  check("later success clears rateLimited", usage.rateLimited === false);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
