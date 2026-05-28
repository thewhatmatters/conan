// US-002 (v4.5) test: the transcript-derived skill-firing reader
// (src/timeline/transcriptScan.ts) + the GET /api/claude/skills enrichment.
//
// Unit half: the pure parser (extractSkillBlocks) on a real-shape JSONL
// fixture with ≥1 Skill block, plus the empty/no-skill case (acceptance
// criterion: "asserts skill/ts extraction + the null case").
//
// Integration half: writes a fixture transcript into a temp HOME's
// ~/.claude/projects/<encoded-cwd>/<sid>.jsonl + a fixture SKILL.md, calls the
// enriched GET /api/claude/skills route, and asserts SkillEntry.lastFiredAt is
// populated for at least one skill (acceptance criterion).
//
// CRITICAL: both CONAN_DATA_DIR and HOME are read at module-import time
// (paths.ts), so we set them BEFORE importing any src/* module — otherwise the
// transcript scanner would freeze on the real $HOME and never see the fixture.
//
// Run: tsx scripts/test-transcript-scan.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-tx-test-"));
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
// Steer node:os.homedir() at the fixture so transcriptPath()/scanRecentSkillFirings
// look under our temp tree instead of the real ~/.claude.
process.env.HOME = tmp;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- shared JSONL fixture --------------------------------------------------
// Mirrors the real Claude Code JSONL shape: one `user` text line, then an
// `assistant` line whose message.content carries a tool_use of name "Skill".
// The Skill input shape is `{skill, args?}` as observed in real transcripts.
const FIXTURE_SID = "tl-tx-fixture";
const FIXTURE_TS = "2026-05-28T10:00:00.000Z";
const FIXTURE_TS2 = "2026-05-28T10:05:00.000Z";
const fixtureLine = (overrides) => JSON.stringify(overrides);

const fixtureJsonl = [
  fixtureLine({
    type: "user",
    sessionId: FIXTURE_SID,
    timestamp: "2026-05-28T09:59:00.000Z",
    cwd: tmp,
    message: { role: "user", content: "Open the page and take a screenshot." },
  }),
  fixtureLine({
    type: "assistant",
    sessionId: FIXTURE_SID,
    timestamp: FIXTURE_TS,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Skill",
          input: { skill: "automate-browser", args: "open http://x" },
        },
      ],
    },
  }),
  // A second firing later in the conversation, different skill.
  fixtureLine({
    type: "assistant",
    sessionId: FIXTURE_SID,
    timestamp: FIXTURE_TS2,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Now I'll generate a PRD.",
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Skill",
          input: { skill: "generate-prd" },
        },
      ],
    },
  }),
  // A non-Skill tool_use line — must be ignored.
  fixtureLine({
    type: "assistant",
    sessionId: FIXTURE_SID,
    timestamp: "2026-05-28T10:06:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls" } },
      ],
    },
  }),
  // Malformed JSON — must be skipped without throwing.
  "{not valid json",
  // Empty line — skipped.
  "",
].join("\n");

// --- unit half: extractSkillBlocks -----------------------------------------
try {
  const {
    extractSkillBlocks,
    readTranscriptSkills,
    scanRecentSkillFirings,
  } = await import("../src/timeline/transcriptScan.ts");

  const records = extractSkillBlocks(fixtureJsonl);
  check(
    "extracts both Skill firings from a real-shape JSONL (order preserved)",
    records.length === 2 &&
      records[0].skill === "automate-browser" &&
      records[1].skill === "generate-prd",
  );
  check(
    "each record's ts is the assistant message's epoch ms",
    records[0].ts === Date.parse(FIXTURE_TS) &&
      records[1].ts === Date.parse(FIXTURE_TS2),
  );
  check(
    "non-Skill tool_use lines (Bash) are ignored",
    !records.some((r) => r.skill === "Bash"),
  );
  check(
    "malformed JSON lines don't throw + don't appear",
    records.every((r) => typeof r.skill === "string" && r.skill.length > 0),
  );

  // Null case — a transcript with NO Skill blocks must return [] (not null,
  // not undefined). Required by acceptance: "skill/ts extraction + the null case".
  const noSkill = [
    fixtureLine({
      type: "user",
      timestamp: "2026-05-28T11:00:00.000Z",
      message: { role: "user", content: "Hi" },
    }),
    fixtureLine({
      type: "assistant",
      timestamp: "2026-05-28T11:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello there." }],
      },
    }),
  ].join("\n");
  const none = extractSkillBlocks(noSkill);
  check("transcript without any Skill block → []", Array.isArray(none) && none.length === 0);

  // An assistant line with a Skill block but no parseable timestamp is skipped
  // rather than fabricating a ts.
  const badTs = fixtureLine({
    type: "assistant",
    timestamp: "not-a-date",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Skill", input: { skill: "x" } }],
    },
  });
  check(
    "Skill block with unparseable timestamp is skipped (no fabricated ts)",
    extractSkillBlocks(badTs).length === 0,
  );

  // A Skill block with no `input.skill` string is skipped.
  const noName = fixtureLine({
    type: "assistant",
    timestamp: "2026-05-28T11:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Skill", input: {} }],
    },
  });
  check("Skill block with no input.skill is skipped", extractSkillBlocks(noName).length === 0);

  // readTranscriptSkills reads from disk via fs — point at a real file.
  const tmpFile = path.join(tmp, "fixture.jsonl");
  fs.writeFileSync(tmpFile, fixtureJsonl);
  const onDisk = readTranscriptSkills(tmpFile);
  check("readTranscriptSkills reads disk + parses (2 firings)", onDisk.length === 2);
  check(
    "readTranscriptSkills on a missing file → [] (never throws)",
    readTranscriptSkills(path.join(tmp, "does-not-exist.jsonl")).length === 0,
  );

  // scanRecentSkillFirings: put the fixture into ~/.claude/projects/<encoded>/
  // (HOME has been overridden to tmp), then assert the bounded scan picks up
  // the most-recent firing for each skill.
  const encodedCwd = tmp.replace(/[/.]/g, "-");
  const projectDir = path.join(tmp, ".claude", "projects", encodedCwd);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${FIXTURE_SID}.jsonl`), fixtureJsonl);

  const fired = scanRecentSkillFirings();
  check(
    "scanRecentSkillFirings finds both skills",
    fired.get("automate-browser") === Date.parse(FIXTURE_TS) &&
      fired.get("generate-prd") === Date.parse(FIXTURE_TS2),
  );
  check(
    "scanRecentSkillFirings ignores skills with no firing",
    fired.get("nonexistent-skill") === undefined,
  );

  // A second firing of the same skill (newer) wins.
  const FIXTURE_TS3 = "2026-05-28T12:00:00.000Z";
  const secondSession = [
    fixtureLine({
      type: "assistant",
      sessionId: "second-fixture",
      timestamp: FIXTURE_TS3,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "automate-browser" } }],
      },
    }),
  ].join("\n");
  fs.writeFileSync(path.join(projectDir, "second-fixture.jsonl"), secondSession);
  const fired2 = scanRecentSkillFirings();
  check(
    "scanRecentSkillFirings takes the most-recent ts across sessions",
    fired2.get("automate-browser") === Date.parse(FIXTURE_TS3),
  );
} catch (err) {
  console.log("FAIL - threw (unit):", err?.stack ?? err?.message ?? err);
  failed = true;
}

// --- integration half: GET /api/claude/skills enriches each entry ----------
try {
  // Install the skill so readSkills finds it. Use the temp HOME so the User
  // skills root resolves under our fixture. (We already set HOME=tmp above.)
  const skillDir = path.join(tmp, ".claude", "skills", "automate-browser");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: automate-browser\ndescription: Browser automation with a persistent login profile.\n---\n# body",
  );

  // Boot the real gateway on the isolated DB/port.
  await import("../src/gateway/index.ts");
  await sleep(300);

  const r = await fetch(`${BASE}/api/claude/skills`, {
    headers: { "x-conan-token": TOKEN },
  });
  check("GET /api/claude/skills returns 200", r.status === 200);
  const entries = await r.json();
  check("response is an array of SkillEntry", Array.isArray(entries) && entries.length > 0);

  const browser = entries.find((s) => s.name === "automate-browser");
  check("the installed skill is present", !!browser);
  check(
    "SkillEntry.lastFiredAt is populated for the firing observed in the fixture",
    browser &&
      typeof browser.lastFiredAt === "number" &&
      browser.lastFiredAt === Date.parse("2026-05-28T12:00:00.000Z"),
  );

  // A skill the fixture never fired must serialize lastFiredAt as null
  // (acceptance: "or omits the line when null — never fabricates").
  fs.mkdirSync(path.join(tmp, ".claude", "skills", "never-fired"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(tmp, ".claude", "skills", "never-fired", "SKILL.md"),
    "---\nname: never-fired\ndescription: A skill never seen in the fixture.\n---\n# body",
  );
  const r2 = await fetch(`${BASE}/api/claude/skills`, {
    headers: { "x-conan-token": TOKEN },
  });
  const entries2 = await r2.json();
  const never = entries2.find((s) => s.name === "never-fired");
  check(
    "an unfired skill carries lastFiredAt: null (never fabricated)",
    never && never.lastFiredAt === null,
  );
} catch (err) {
  console.log("FAIL - threw (integration):", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
