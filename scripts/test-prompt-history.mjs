// US-015 test: prompt-history — read ~/.claude/history.jsonl, return entries
// [{display, timestamp, project}] newest-first with optional text search +
// project filter + limit/offset pagination.
//
// Exercises the pure module against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR), then the gateway route end-to-end:
//   - newest-first ordering (file is appended oldest-first)
//   - case-insensitive `q` search over display
//   - project (cwd) substring filter
//   - limit/offset pagination; total reflects the matched set
//   - malformed lines skipped; missing file → empty, no throw
//
// Run: tsx scripts/test-prompt-history.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-prompthist-test-"));
const claudeDir = path.join(tmp, "dot-claude");
fs.mkdirSync(claudeDir, { recursive: true });

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.CONAN_DATA_DIR, { recursive: true });
process.env.CONAN_AUTH_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed history.jsonl oldest-first. Mix of two projects, a malformed line, a
// line with no `display` (skipped), and a non-numeric timestamp.
const lines = [
  JSON.stringify({ display: "Create index.html", pastedContents: {}, timestamp: 1000, project: "/a/whatmatters" }),
  JSON.stringify({ display: "italicize matters", pastedContents: {}, timestamp: 2000, project: "/a/whatmatters" }),
  "{ not json",
  JSON.stringify({ pastedContents: {}, timestamp: 2500, project: "/a/whatmatters" }), // no display → skipped
  JSON.stringify({ display: "Add a Tailwind CONFIG", timestamp: 3000, project: "/b/conan" }),
  JSON.stringify({ display: "fix the build", timestamp: "nope", project: "/b/conan" }),
  JSON.stringify({ display: "newest prompt", timestamp: 9000, project: "/b/conan" }),
];
fs.writeFileSync(path.join(claudeDir, "history.jsonl"), lines.join("\n") + "\n");

try {
  const mod = await import("../src/prompt-history/index.ts");

  // --- pure module --------------------------------------------------------
  const all = await mod.readPromptHistory({ claudeDir });
  check("skips malformed + display-less lines (5 valid)", all.total === 5 && all.entries.length === 5);
  check("newest-first ordering", all.entries[0].display === "newest prompt" && all.entries[0].timestamp === 9000);
  check("oldest valid entry last", all.entries[all.entries.length - 1].display === "Create index.html");
  check("non-numeric timestamp → null", all.entries.some((e) => e.display === "fix the build" && e.timestamp === null));
  check("entry shape is the safe subset", Object.keys(all.entries[0]).sort().join(",") === "display,project,timestamp");

  // case-insensitive text search
  const q = await mod.readPromptHistory({ claudeDir, q: "config" });
  check("q search is case-insensitive", q.total === 1 && q.entries[0].display === "Add a Tailwind CONFIG");

  // project filter
  const proj = await mod.readPromptHistory({ claudeDir, project: "/a/whatmatters" });
  check("project filter (substring)", proj.total === 2 && proj.entries.every((e) => e.project === "/a/whatmatters"));

  // pagination
  const page = await mod.readPromptHistory({ claudeDir, limit: 2, offset: 1 });
  check("limit/offset paginates the matched set", page.total === 5 && page.entries.length === 2 && page.limit === 2 && page.offset === 1);
  check("offset skips the newest", page.entries[0].display !== "newest prompt");

  // combined filter + pagination
  const combo = await mod.readPromptHistory({ claudeDir, project: "/b/conan", limit: 1 });
  check("combined filter + limit", combo.total === 3 && combo.entries.length === 1 && combo.entries[0].display === "newest prompt");

  // limit clamping
  const clamp = await mod.readPromptHistory({ claudeDir, limit: 99999 });
  check("limit clamped to MAX (500)", clamp.limit === 500);
  const clampLow = await mod.readPromptHistory({ claudeDir, limit: 0 });
  check("limit clamped to >= 1", clampLow.limit === 1);

  // missing file → empty, no throw
  const empty = await mod.readPromptHistory({ claudeDir: path.join(tmp, "nope") });
  check("missing file → empty result", empty.total === 0 && empty.entries.length === 0);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/prompt-history`)).json();
  check("GET returns entries + total + limit + offset", Array.isArray(g.entries) && g.total === 5 && typeof g.limit === "number");

  const gq = await (await fetch(`${BASE}/api/claude/prompt-history?q=build`)).json();
  check("GET ?q= filters", gq.total === 1 && gq.entries[0].display === "fix the build");

  const gpage = await (await fetch(`${BASE}/api/claude/prompt-history?limit=2&offset=2`)).json();
  check("GET ?limit=&offset= paginates", gpage.entries.length === 2 && gpage.offset === 2 && gpage.total === 5);

  const gproj = await (await fetch(`${BASE}/api/claude/prompt-history?project=${encodeURIComponent("/b/conan")}`)).json();
  check("GET ?project= filters", gproj.total === 3);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
