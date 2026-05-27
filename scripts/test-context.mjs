// US-009 test: the pure /context frame parser (src/context/index.ts), exercised
// against a captured sample frame (scripts/fixtures/context-frame.txt) — the
// session-specific scrape can't run in CI (it needs a live, logged-in claude
// session), so the parser is the testable unit, mirroring scripts/test-usage.mjs.
//
// Also round-trips the per-session cache (cache → get → clear).
//
// Run: tsx scripts/test-context.mjs
import fs from "node:fs";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

try {
  const ctx = await import("../src/context/index.ts");

  const fixture = fs.readFileSync(
    new URL("./fixtures/context-frame.txt", import.meta.url),
    "utf8",
  );
  const cap = ctx.parseContextFrame(fixture);

  check("frame parses to a capture object", !!cap);
  // The slug must come from the /context header, NOT the "Claude Code vX.Y.Z"
  // startup banner that precedes it in the captured buffer.
  check("model slug parsed from header (not the banner)", cap?.model === "claude-opus-4-7");
  check("model display name derived w/ 1M from window", cap?.modelDisplay === "Claude Opus 4.7 (1M)");
  check("used tokens parsed (45k -> 45000)", cap?.usedTokens === 45_000);
  check("window tokens parsed (1M -> 1000000)", cap?.windowTokens === 1_000_000);
  check("used pct parsed", cap?.usedPct === 4);

  const byKey = Object.fromEntries((cap?.categories ?? []).map((c) => [c.key, c]));
  check("all 7 categories parsed", (cap?.categories?.length ?? 0) === 7);
  check("system prompt tokens", byKey.system?.tokens === 2_900);
  check("system prompt pct", byKey.system?.pct === 0.3);
  check("system tools tokens", byKey.tools?.tokens === 12_100);
  check("mcp tools tokens", byKey.mcp?.tokens === 6_500);
  check("memory files tokens", byKey.memory?.tokens === 9_700);
  check("skills tokens", byKey.skills?.tokens === 7_600);
  check("messages tokens", byKey.messages?.tokens === 6_300);
  check("free space tokens (no 'tokens' word)", byKey.free?.tokens === 955_000);
  check("free space pct", byKey.free?.pct === 95.5);
  check(
    "categories ordered as /context renders them",
    JSON.stringify((cap?.categories ?? []).map((c) => c.key)) ===
      JSON.stringify(["system", "tools", "mcp", "memory", "skills", "messages", "free"]),
  );

  // Garbage / unrelated terminal output must not parse.
  check("plain output -> null", ctx.parseContextFrame("just some shell output\n$ ls") === null);
  check("empty -> null", ctx.parseContextFrame("") === null);

  // Free space alone (no header total) still parses as a real frame.
  const partial = ctx.parseContextFrame("Free space: 100k (50%)");
  check("free-space-only frame parses", !!partial && partial.categories.length === 1);

  // --- per-session cache round-trip ---------------------------------------
  check("getCapturedContext null before any capture", ctx.getCapturedContext("sess-x") === null);
  ctx.cacheCapturedContext("sess-x", cap);
  const got = ctx.getCapturedContext("sess-x");
  check("cached capture is retrievable", !!got && got.usedTokens === 45_000);
  check("cache stamps capturedAt", typeof got?.capturedAt === "number" && got.capturedAt > 0);
  ctx.clearCapturedContext("sess-x");
  check("clearCapturedContext drops it", ctx.getCapturedContext("sess-x") === null);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
