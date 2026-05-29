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
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
// Never spawn a real `claude` pty during tests (US-005 probe is live-only).
process.env.CONAN_DISABLE_USAGE_PROBE = "1";

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

  // --- US-005 /usage frame parser (against a real captured frame) ----------
  const probe = await import("../src/usage/probe.ts");
  const fixture = fs.readFileSync(
    new URL("./fixtures/usage-frame.txt", import.meta.url),
    "utf8",
  );
  // The captured frame (America/Chicago) shows: Current session 50% used, resets
  // 12:20am; Current week (all models) 12% used, resets Jun 1 at 3pm.
  const ref = Date.parse("2026-05-25T20:00:00Z"); // a fixed "now" for determinism
  const plan = probe.parseUsageFrame(fixture, ref);
  check("frame parses to a plan object", !!plan);
  check("five-hour window found", !!plan?.fiveHour);
  check("five-hour utilizationPct = 50", plan?.fiveHour?.utilizationPct === 50);
  check("five-hour resetAt is a future epoch", typeof plan?.fiveHour?.resetAt === "number" && plan.fiveHour.resetAt > ref);
  check("seven-day window found", !!plan?.sevenDay);
  check("seven-day utilizationPct = 12", plan?.sevenDay?.utilizationPct === 12);
  check("seven-day resetAt parses the dated reset", typeof plan?.sevenDay?.resetAt === "number" && plan.sevenDay.resetAt > ref);
  check("status derived (50%/12% -> ok)", plan?.status === "ok");
  // The 2-window capture has no Sonnet-only window (US-010 backward-compat).
  check("no Sonnet-only window in the 2-window frame", plan?.sevenDaySonnet === null);

  // --- US-010 full /usage frame: Session block + all 3 windows -------------
  // A frame covering the Session block (cost/durations/code/per-model) + all
  // three rate-limit windows including "Current week (Sonnet only)". (Modeled on
  // the real /usage layout — a billed multi-model session can't be captured in
  // CI — and exercises the same ANSI-strip + collapse path as the real capture.)
  const fullFrame = fs.readFileSync(
    new URL("./fixtures/usage-frame-full.txt", import.meta.url),
    "utf8",
  );
  const full = probe.parseUsageFrame(fullFrame, ref);
  check("full frame: 5h window = 35%", full?.fiveHour?.utilizationPct === 35);
  check("full frame: 7d all-models = 62%", full?.sevenDay?.utilizationPct === 62);
  check("full frame: 7d Sonnet-only = 18%", full?.sevenDaySonnet?.utilizationPct === 18);
  check("full frame: all 3 windows have resets", typeof full?.fiveHour?.resetAt === "number" && typeof full?.sevenDay?.resetAt === "number" && typeof full?.sevenDaySonnet?.resetAt === "number");
  check("full frame: status (62% -> ok)", full?.status === "ok");

  const sess = probe.parseUsageSession(fullFrame);
  check("session block parses", !!sess);
  check("session total cost = $12.34", Math.abs((sess?.totalCostUsd ?? 0) - 12.34) < 1e-6);
  check("session API duration = 1h2m (ms)", sess?.apiDurationMs === 3_720_000);
  check("session wall duration = 2h5m (ms)", sess?.wallDurationMs === 7_500_000);
  check("session lines added = 1234", sess?.linesAdded === 1234);
  check("session lines removed = 567", sess?.linesRemoved === 567);
  check("session by-model: 2 models", (sess?.byModel?.length ?? 0) === 2);
  const opus = sess?.byModel?.find((m) => m.model === "claude-opus-4-7");
  check("opus row parsed (slug + display)", opus?.modelDisplay === "Claude Opus 4.7");
  check("opus input 1.2k -> 1200", opus?.inputTokens === 1200);
  check("opus output 45.6k -> 45600", opus?.outputTokens === 45_600);
  check("opus cache-read 1.8m -> 1.8M", opus?.cacheReadTokens === 1_800_000);
  check("opus cache-write 134.6k", opus?.cacheWriteTokens === 134_600);
  const sonnet = sess?.byModel?.find((m) => m.model === "claude-sonnet-4-6");
  check("sonnet row parsed", sonnet?.outputTokens === 12_000 && sonnet?.cacheReadTokens === 320_000);

  // The $0 session ($0 fixture) renders an aggregate "Usage:" line (no per-model
  // breakdown) — represented as one entry with model=null, never blank.
  const sessAgg = probe.parseUsageSession(fixture);
  check("aggregate session block parses ($0)", !!sessAgg && sessAgg.totalCostUsd === 0);
  check("aggregate by-model is one model=null entry", sessAgg?.byModel?.length === 1 && sessAgg.byModel[0].model === null);
  check("garbage frame -> no session block", probe.parseUsageSession("just shell output\n$ ls") === null);

  // --- US-007 "What's contributing" insights + Skills % parsers -----------
  // (a) The clean synthetic full frame: precise headline/factor/advice + skills.
  const insights = probe.parseUsageInsights(fullFrame);
  check("insights: 2 parsed from the full frame", insights.length === 2);
  check("insight[0] headlinePct = 43", insights[0]?.headlinePct === 43);
  check("insight[0] factor carries the >150k text", /150k context/.test(insights[0]?.factor ?? ""));
  check("insight[0] advice captured", /compact/.test(insights[0]?.advice ?? ""));
  check("insight[1] headlinePct = 73", insights[1]?.headlinePct === 73);
  check("insight[1] factor carries the 8+ hours text", /8\+ hours/.test(insights[1]?.factor ?? ""));
  check("insight[1] advice captured", /clear/.test(insights[1]?.advice ?? ""));
  check("insights: caveat line is not an insight", insights.every((i) => !/Approximate/i.test(i.factor)));

  const skills = probe.parseUsageSkills(fullFrame);
  check("skills: 2 rows parsed", skills.length === 2);
  check("skills[0] = automate-browser 3% (slash stripped)", skills[0]?.name === "automate-browser" && skills[0]?.pct === 3);
  check("skills[1] = deep-research 1%", skills[1]?.name === "deep-research" && skills[1]?.pct === 1);

  // (b) The REAL captured frame (usage-frame.txt) — column-positioned, words
  // glued, percents glued to skill names, and re-rendered twice. The parser must
  // still extract the cleanly-rendered headlines + skill rows, deduped, without
  // pulling in the Subagents table.
  const realInsights = probe.parseUsageInsights(fixture);
  check("real frame: 3 clean insights extracted (deduped)", realInsights.length === 3);
  check("real frame insight pcts = [43,39,10]", JSON.stringify(realInsights.map((i) => i.headlinePct)) === "[43,39,10]");
  check("real frame: factor survives glued (>150k)", /150kcontext/i.test(realInsights[0]?.factor ?? ""));
  check("real frame: no caveat leaked as insight", realInsights.every((i) => !/Approximate|Last24h/i.test(i.factor)));

  const realSkills = probe.parseUsageSkills(fixture);
  check("real frame: 3 skills (glued pct split)", realSkills.length === 3);
  check("real frame skills names", JSON.stringify(realSkills.map((s) => s.name)) === '["automate-browser","update-config","deep-research"]');
  check("real frame skills pcts", JSON.stringify(realSkills.map((s) => s.pct)) === "[10,4,1]");
  check("real frame: Subagents row NOT counted as a skill", !realSkills.some((s) => s.name === "general-purpose"));

  // (c) Both return [] cleanly when the section is absent (garbage / non-usage).
  check("parseUsageInsights -> [] on garbage", probe.parseUsageInsights("just shell output\n$ ls").length === 0);
  check("parseUsageSkills -> [] on garbage", probe.parseUsageSkills("just shell output\n$ ls").length === 0);
  check("parseUsageInsights -> [] on a windows-only frame", probe.parseUsageInsights("Current session\n50% used\nResets 1am (America/Chicago)").length === 0);
  check("parseUsageSkills -> [] on a windows-only frame", probe.parseUsageSkills("Current session\n50% used\nResets 1am (America/Chicago)").length === 0);

  // Live-usage per-session cache round-trip (US-010).
  check("getCapturedUsage null before capture", probe.getCapturedUsage("sess-live") === null);
  probe.cacheCapturedUsage("sess-live", { session: sess, fiveHour: full.fiveHour, sevenDay: full.sevenDay, sevenDaySonnet: full.sevenDaySonnet, status: full.status });
  const live = probe.getCapturedUsage("sess-live");
  check("captured usage retrievable", !!live && live.session?.totalCostUsd === 12.34);
  check("captured usage stamps capturedAt", typeof live?.capturedAt === "number" && live.capturedAt > 0);
  probe.clearCapturedUsage("sess-live");
  check("clearCapturedUsage drops it", probe.getCapturedUsage("sess-live") === null);

  // status thresholds + standalone reset parsing.
  check(
    "warning at 80%+",
    probe.parseUsageFrame("Current session\n80% used\nResets 1am (America/Chicago)", ref)?.status === "warning",
  );
  check(
    "limit at 100%+",
    probe.parseUsageFrame("Current session\n100% used\nResets 1am (America/Chicago)", ref)?.status === "limit",
  );
  check(
    "garbage frame -> null",
    probe.parseUsageFrame("no usage here at all", ref) === null,
  );
  check(
    "time-only reset resolves to next occurrence",
    typeof probe.parseResetAt("3pm", "America/Chicago", ref) === "number",
  );
  check(
    "dated reset resolves",
    typeof probe.parseResetAt("Jun 1 at 3pm", "America/Chicago", ref) === "number",
  );
  check(
    "unparseable reset -> null",
    probe.parseResetAt("whenever", null, ref) === null,
  );
  check(
    "stripAnsi removes CSI sequences",
    !probe.stripAnsi("\x1b[1;32mhi\x1b[0m").includes("\x1b"),
  );
  check(
    "getCachedPlanUtilization null before any probe",
    probe.getCachedPlanUtilization() === null,
  );
  check(
    "maybeProbe is a no-op when disabled (returns cached null)",
    (await probe.maybeProbe()) === null,
  );

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const { getDb } = await import("../src/db/index.ts");
  const db = getDb();
  const now = Date.now();

  // Sessions across the rolling windows, with known cost + output_tokens on the
  // session row (the plan-usage token trend reads the session columns):
  //   sess-a, sess-b: active now -> in 5h AND 7d, and count toward costToday
  //   sess-c: active 3 days ago -> in 7d only, NOT today (excluded from cost)
  const upSession = db.prepare(
    `INSERT INTO session (id, model, status, created_at, last_activity, total_cost_usd, output_tokens)
       VALUES (?, 'claude-opus-4-7', 'running', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET total_cost_usd = excluded.total_cost_usd,
                                   last_activity = excluded.last_activity,
                                   output_tokens = excluded.output_tokens`,
  );
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  upSession.run("sess-a", now - 3_600_000, now, 1.25, 800);
  upSession.run("sess-b", now - 3_600_000, now, 0.75, 400); // costToday = 2.00
  upSession.run("sess-c", now - THREE_DAYS, now - THREE_DAYS, 5.0, 5000);

  const insEvent = db.prepare(
    `INSERT INTO event (session_id, hook_event_name, stream_type, tool_name, payload, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Result rows -> tokensToday = 1200.
  insEvent.run("sess-a", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 800 } }), now - 60_000);
  insEvent.run("sess-b", null, "result", null, JSON.stringify({ type: "result", usage: { output_tokens: 400 } }), now - 50_000);

  let usage = await (await fetch(`${BASE}/api/claude/usage`)).json();
  check("costToday aggregates today's session cost (informational)", Math.abs(usage.costToday - 2.0) < 1e-6);
  check("tokensToday sums result output tokens", usage.tokensToday === 1200);
  check("tokensRecent.last5h sums recent session tokens", usage.tokensRecent?.last5h === 1200);
  check("tokensRecent.last7d includes older sessions", usage.tokensRecent?.last7d === 6200);
  check("no dollar ceiling/pct in response", !("dailyCeilingUsd" in usage) && !("pct" in usage));
  check("planUtilization present (null with no fresh probe)", "planUtilization" in usage && usage.planUtilization === null);
  check("liveUsage present (null without ?session, US-010)", "liveUsage" in usage && usage.liveUsage === null);
  check("not rate-limited with no retry events", usage.rateLimited === false);
  check("hasData true once usage recorded", usage.hasData === true);

  // US-010: ?session=<id> binds the live capture; null when none captured.
  const usageSess = await (await fetch(`${BASE}/api/claude/usage?session=sess-a`)).json();
  check("liveUsage null for a session with no captured frame", usageSess.liveUsage === null);

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
