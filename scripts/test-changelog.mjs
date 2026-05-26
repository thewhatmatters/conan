// US-007 test: changelog feed parsed from ~/.claude/cache/changelog.md.
// Exercises the pure changelog module against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR / CONAN_CLAUDE_JSON), then the gateway route end-to-end:
//   - parses `## <version>` headings + flat `- ` bullets into entries[]
//   - entries are newest-first as written; every date is null (no dates in src)
//   - installedVersion comes from the most-recent sessions/<pid>.json `version`
//   - entries strictly newer than lastReleaseNotesSeen are flagged isNew
//   - changelogLastFetched is the file mtime; missing file → safe empty shape
//
// Run: tsx scripts/test-changelog.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-changelog-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const claudeJson = path.join(tmp, "dot-claude.json");
fs.mkdirSync(path.join(claudeDir, "cache"), { recursive: true });
fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_CLAUDE_JSON = claudeJson;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byVer = (v, list) => list.find((e) => e.version === v);

// Seed a changelog: newest-first headings + flat bullets, mirroring the real
// format (uniform `## <version>`, flat `- `, no dates).
const CHANGELOG = `# Changelog

## 2.1.151

- Brand new shiny feature
- Another fresh thing

## 2.1.150

- Internal infrastructure improvements (no user-facing changes)

## 2.1.149

- A fix for the thing
- A fix for the other thing
`;
fs.writeFileSync(path.join(claudeDir, "cache", "changelog.md"), CHANGELOG);

// lastReleaseNotesSeen = 2.1.150 → only 2.1.151 should be flagged new.
fs.writeFileSync(claudeJson, JSON.stringify({ lastReleaseNotesSeen: "2.1.150" }));

// A live session file reports the installed build (preferred over lastSeen).
fs.writeFileSync(
  path.join(claudeDir, "sessions", "12345.json"),
  JSON.stringify({ pid: 12345, sessionId: "abc", version: "2.1.151" }),
);

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/changelog/index.ts");
  const out = mod.readChangelog();

  check("parses all three version entries", out.entries.length === 3);
  check(
    "entries are newest-first as written (2.1.151 first)",
    out.entries[0].version === "2.1.151" && out.entries[2].version === "2.1.149",
  );
  check(
    "2.1.151 has both bullet items",
    byVer("2.1.151", out.entries).items.length === 2 &&
      byVer("2.1.151", out.entries).items[0] === "Brand new shiny feature",
  );
  check("every entry date is null (no dates in source)", out.entries.every((e) => e.date === null));

  check(
    "newer-than-lastSeen flagged isNew (2.1.151 only)",
    byVer("2.1.151", out.entries).isNew === true &&
      byVer("2.1.150", out.entries).isNew === false &&
      byVer("2.1.149", out.entries).isNew === false,
  );

  check("installedVersion from sessions/<pid>.json", out.installedVersion === "2.1.151");
  check("lastReleaseNotesSeen read from ~/.claude.json", out.lastReleaseNotesSeen === "2.1.150");
  check("changelogLastFetched is an epoch ms number", typeof out.changelogLastFetched === "number" && out.changelogLastFetched > 0);

  // --- missing file → safe empty shape ------------------------------------
  fs.rmSync(path.join(claudeDir, "cache", "changelog.md"));
  const empty = mod.readChangelog();
  check("missing changelog → empty entries", Array.isArray(empty.entries) && empty.entries.length === 0);
  check("missing changelog → changelogLastFetched null", empty.changelogLastFetched === null);
  check("missing changelog → installedVersion still resolved", empty.installedVersion === "2.1.151");

  // restore the file for the gateway round-trip
  fs.writeFileSync(path.join(claudeDir, "cache", "changelog.md"), CHANGELOG);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/changelog`)).json();
  check("GET /api/claude/changelog returns entries", Array.isArray(g.entries) && g.entries.length === 3);
  check("GET reports installedVersion", g.installedVersion === "2.1.151");
  check("GET flags the new entry", byVer("2.1.151", g.entries).isNew === true);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
