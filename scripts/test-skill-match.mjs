// US-003 (v4.5) test: src/skills/match.ts (BM25 + rule layer) + the
// `prompt_consideration` persistence + `{type:'skill-considered'}` WS
// broadcast on UserPromptSubmit + the Stop reconciliation flip to fired=1.
//
// Unit half: scoreSkills() over a small 4-skill fixture — BM25 ranking + each
// documented rule's classification (prompt-mentions, UI-keyword, diagram,
// strong, partial, none).
//
// Integration half (a): boot the gateway on an isolated DB, open the app /ws,
// post a UserPromptSubmit event, and assert (1) the expected prompt_consideration
// rows persisted, (2) at least one `{type:'skill-considered'}` WS frame
// arrived.
//
// Integration half (b): write a real-shape JSONL with a Skill tool_use AFTER
// the prompt, post a Stop event, and assert the matching prompt_consideration
// row flipped fired=1 with the fired reason.
//
// CRITICAL: HOME + CONAN_DATA_DIR must be set BEFORE importing any src/* —
// paths.ts freezes both at import time. Skills + transcripts are read off HOME.
//
// Run: tsx scripts/test-skill-match.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-skill-match-"));
const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.HOME = tmp;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Unit: scoreSkills + each rule -----------------------------------------
try {
  const {
    scoreSkills,
    topMatches,
    tokenize,
    classifyReason,
    HIGH_SCORE_THRESHOLD,
    LOW_SCORE_THRESHOLD,
    CONSIDERATION_TOP_N,
  } = await import("../src/skills/match.ts");

  // 4-skill fixture: one UI/browser, one diagram, one totally unrelated, one
  // whose description shares overlap terms with the prompt.
  const skills = [
    {
      name: "automate-browser",
      description:
        "Browser automation with a persistent login profile. Use when the user wants to navigate websites, fill forms, click through flows, or take screenshots.",
      source: "User",
    },
    {
      name: "draw-diagram",
      description:
        "Turn intent into Mermaid diagrams — flowcharts, sequence, state, architecture diagrams — and render them as Markdown.",
      source: "User",
    },
    {
      name: "audit-skill",
      description:
        "Audit a Claude skill against the canonical skill-architecture spec. Reviews structure, reliability, secret hygiene.",
      source: "User",
    },
    {
      name: "internal-comms",
      description:
        "Help me write internal communications — status reports, leadership updates, newsletters.",
      source: "User",
    },
  ];

  // --- ranking: a UI prompt ranks automate-browser at the top --------------
  const uiPrompt =
    "Open the dashboard and take a screenshot of the chart on the homepage.";
  const ranked = topMatches(scoreSkills(uiPrompt, skills));
  check(
    "BM25 ranking returns 4 rows for 4 skills",
    Array.isArray(ranked) && ranked.length === 4,
  );
  check(
    "automate-browser ranks above audit-skill on a UI-flavored prompt",
    (ranked.find((r) => r.skill === "automate-browser")?.score ?? 0) >
      (ranked.find((r) => r.skill === "audit-skill")?.score ?? 0),
  );
  check(
    "all scores are finite non-negative numbers",
    ranked.every((r) => Number.isFinite(r.score) && r.score >= 0),
  );

  // --- rule: prompt mentions this skill by name ----------------------------
  // The prompt contains the skill name verbatim → rule wins over the score
  // tier even if the BM25 score would also clear HIGH.
  const mentionsRes = scoreSkills(
    "use the automate-browser skill to open the page",
    skills,
  );
  check(
    "rule: prompt mentions this skill (kebab form, verbatim)",
    mentionsRes.find((r) => r.skill === "automate-browser")?.reason ===
      "prompt mentions this skill",
  );
  // Space-flattened name form.
  const mentionsSpaced = scoreSkills(
    "draw a fancy diagram with the draw diagram tool",
    skills,
  );
  check(
    "rule: skill-name mentioned in space-flattened form",
    mentionsSpaced.find((r) => r.skill === "draw-diagram")?.reason ===
      "prompt mentions this skill",
  );

  // --- rule: UI keyword match ----------------------------------------------
  // Description has "browser" + prompt has a UI verb (screenshot/click/render/style).
  // The prompt MUST NOT mention the skill name, or the previous rule wins.
  const uiKwRes = scoreSkills(
    "render the page and click submit, then capture a screenshot",
    skills,
  );
  check(
    "rule: UI keyword match (browser desc + UI verb prompt)",
    uiKwRes.find((r) => r.skill === "automate-browser")?.reason ===
      "UI keyword match",
  );

  // --- rule: diagram intent -----------------------------------------------
  // Both prompt and description reference diagram/chart/flowchart, prompt
  // must not say the skill name.
  const diagRes = scoreSkills(
    "I want a flowchart of the build pipeline",
    skills,
  );
  check(
    "rule: diagram intent (flowchart in both prompt + description)",
    diagRes.find((r) => r.skill === "draw-diagram")?.reason ===
      "diagram intent",
  );

  // --- rule: strong description match (score >= HIGH) ---------------------
  // Pick a prompt that overlaps strongly with audit-skill's description but
  // doesn't say "audit-skill" verbatim.
  const strongRes = scoreSkills(
    "spec architecture canonical reliability hygiene reviews structure secret reviews",
    skills,
  );
  const auditStrong = strongRes.find((r) => r.skill === "audit-skill");
  check(
    "rule: strong description match for a high-BM25 prompt",
    auditStrong &&
      auditStrong.score >= HIGH_SCORE_THRESHOLD &&
      auditStrong.reason.startsWith("strong description match (terms:"),
  );

  // --- rule: partial match ([LOW, HIGH)) ----------------------------------
  // Single-term overlap with internal-comms's description (`status`) → mid score.
  // (Two-term overlap would push it past HIGH on a tiny 4-doc corpus.)
  const partialRes = scoreSkills("share the latest status", skills);
  const partialRow = partialRes.find((r) => r.skill === "internal-comms");
  check(
    "rule: partial match for a low/mid-BM25 prompt",
    partialRow &&
      partialRow.score >= LOW_SCORE_THRESHOLD &&
      partialRow.score < HIGH_SCORE_THRESHOLD &&
      partialRow.reason.startsWith("partial match (terms:"),
  );

  // --- rule: no description match -----------------------------------------
  const noneRes = scoreSkills("xyzzy zorblax frobnicate", skills);
  check(
    "rule: no description match when nothing overlaps",
    noneRes.every((r) => r.reason.startsWith("no description match (top terms:")),
  );

  // --- empty prompt + empty skills are no-ops -----------------------------
  check("empty prompt → []", scoreSkills("", skills).length === 0);
  check("empty skills → []", scoreSkills("hi", []).length === 0);

  // --- tokenize basics ---------------------------------------------------
  check(
    "tokenize lowercases + strips punctuation + drops stop words",
    JSON.stringify(tokenize("Click the BUTTON, then take a screenshot.")) ===
      JSON.stringify(["click", "button", "take", "screenshot"]),
  );
  check(
    "tokenize splits on hyphens (kebab fans out)",
    tokenize("automate-browser is awesome").includes("automate") &&
      tokenize("automate-browser is awesome").includes("browser"),
  );

  // --- top-N picker -------------------------------------------------------
  check(
    "topMatches picks N highest, stable across runs",
    topMatches(scoreSkills(uiPrompt, skills), 2).length === 2,
  );
  check(
    "CONSIDERATION_TOP_N is exposed and a positive integer",
    Number.isInteger(CONSIDERATION_TOP_N) && CONSIDERATION_TOP_N > 0,
  );

  // --- classifyReason directly (callable + deterministic) -----------------
  const direct = classifyReason({
    skillName: "automate-browser",
    description: "browser stuff",
    promptLower: "automate-browser is cool",
    promptTokens: new Set(["automate", "browser", "cool"]),
    score: 0.1,
    topTerms: [],
  });
  check(
    "classifyReason: name match beats low score → 'prompt mentions this skill'",
    direct === "prompt mentions this skill",
  );
} catch (err) {
  console.log("FAIL - threw (unit):", err?.stack ?? err?.message ?? err);
  failed = true;
}

// --- Integration: gateway boot, then UserPromptSubmit + Stop -----------
// The gateway boots once and is shared by both halves below — booting twice
// in the same process would collide on :PORT.
let WS_FRAMES;
let wsReady;
try {
  // Install a skill so readSkills() finds something to score. HOME=tmp is set.
  const skillDir = path.join(tmp, ".claude", "skills", "automate-browser");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: automate-browser\ndescription: Browser automation with a persistent login profile. Click through flows, take screenshots.\n---\n# body",
  );
  // A second skill so we have ≥2 docs (BM25 IDF needs >1 doc for proper signal).
  const skillDir2 = path.join(tmp, ".claude", "skills", "draw-diagram");
  fs.mkdirSync(skillDir2, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir2, "SKILL.md"),
    "---\nname: draw-diagram\ndescription: Turn intent into Mermaid diagrams — flowcharts, sequence, architecture.\n---\n# body",
  );

  // Boot the gateway.
  await import("../src/gateway/index.ts");
  await sleep(300);

  // Open the app WS and collect every frame for the rest of the test.
  WS_FRAMES = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  ws.on("message", (d) => {
    try {
      WS_FRAMES.push(JSON.parse(d.toString()));
    } catch {
      /* ignore non-JSON */
    }
  });
  wsReady = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  await wsReady;
  await sleep(100); // let hello/tasks frames settle

  const post = async (body) => {
    const r = await fetch(`${BASE}/api/claude/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": TOKEN },
      body: JSON.stringify(body),
    });
    return r.json();
  };

  // --- Half (a): UserPromptSubmit → persisted + broadcast -----------------
  const SID = "match-real-sid";
  const promptText =
    "Open the page in the browser and take a screenshot of the dashboard.";
  const r1 = await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "UserPromptSubmit",
    payload: {
      session_id: SID,
      hook_event_name: "UserPromptSubmit",
      prompt: promptText,
    },
  });
  check("UserPromptSubmit ingest returns {ok:true}", r1?.ok === true);
  const promptEventId = r1?.id;
  check("ingest returns the persisted event id", typeof promptEventId === "number");
  await sleep(100);

  // The rows must land in prompt_consideration keyed by this event id.
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(tmp, "data", "conan.db"), { readonly: true });
  const persisted = db
    .prepare(
      "SELECT event_id, skill, score, reason, fired FROM prompt_consideration WHERE event_id = ? ORDER BY score DESC",
    )
    .all(promptEventId);
  check(
    "prompt_consideration: ≥1 row persisted for the prompt event",
    persisted.length >= 1,
  );
  check(
    "every persisted row has score: REAL, reason: TEXT, fired=0",
    persisted.every(
      (r) =>
        typeof r.score === "number" &&
        typeof r.reason === "string" &&
        r.reason.length > 0 &&
        r.fired === 0,
    ),
  );
  check(
    "automate-browser is one of the persisted skills (UI-flavored prompt)",
    persisted.some((r) => r.skill === "automate-browser"),
  );
  db.close();

  // The {type:'skill-considered'} broadcast must have landed.
  const considered = WS_FRAMES.filter((f) => f?.type === "skill-considered");
  check(
    "≥1 {type:'skill-considered'} WS frame arrived for this session",
    considered.length >= 1 &&
      considered.every((f) => f.sessionId === SID),
  );
  check(
    "broadcast payload carries the TimelineRow shape (kind, ts, skill, promptEventId, reason, heuristic:true)",
    considered.every(
      (f) =>
        f.payload?.kind === "skill-considered" &&
        typeof f.payload.ts === "number" &&
        typeof f.payload.skill === "string" &&
        f.payload.promptEventId === promptEventId &&
        typeof f.payload.reason === "string" &&
        f.payload.heuristic === true,
    ),
  );

  // The Timeline read route emits the considered rows.
  const tlRows = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  const tlConsidered = tlRows.filter((r) => r.kind === "skill-considered");
  check(
    "GET /timeline returns the persisted considered rows (fired=0)",
    tlConsidered.length >= 1 &&
      tlConsidered.every(
        (r) => r.heuristic === true && r.promptEventId === promptEventId,
      ),
  );

  // --- Half (b): Stop reconciliation flips fired=1 -----------------------
  // Write a transcript JSONL containing a Skill tool_use for a skill we
  // know is in prompt_consideration (automate-browser), AFTER the prompt's ts.
  // The transcript path encoding mirrors transcriptPath() in src/transcript.
  const encodedCwd = tmp.replace(/[/.]/g, "-");
  const projectDir = path.join(tmp, ".claude", "projects", encodedCwd);
  fs.mkdirSync(projectDir, { recursive: true });
  const fixtureTs = new Date(Date.now() + 1000).toISOString();
  const transcriptJsonl = [
    JSON.stringify({
      type: "assistant",
      sessionId: SID,
      timestamp: fixtureTs,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_x",
            name: "Skill",
            input: { skill: "automate-browser" },
          },
        ],
      },
    }),
  ].join("\n");
  fs.writeFileSync(
    path.join(projectDir, `${SID}.jsonl`),
    transcriptJsonl,
  );

  const r2 = await post({
    session_id: SID,
    cwd: tmp,
    hook_event_name: "Stop",
    payload: { session_id: SID, hook_event_name: "Stop" },
  });
  check("Stop ingest returns {ok:true}", r2?.ok === true);
  await sleep(100);

  const db2 = new Database(path.join(tmp, "data", "conan.db"), { readonly: true });
  const rec = db2
    .prepare(
      "SELECT fired, reason FROM prompt_consideration WHERE event_id = ? AND skill = ?",
    )
    .get(promptEventId, "automate-browser");
  check(
    "Stop flipped automate-browser to fired=1 + fired reason",
    rec &&
      rec.fired === 1 &&
      typeof rec.reason === "string" &&
      rec.reason.startsWith("fired"),
  );
  // A row whose skill DIDN'T fire stays fired=0.
  const otherRow = db2
    .prepare(
      "SELECT fired FROM prompt_consideration WHERE event_id = ? AND skill != 'automate-browser' LIMIT 1",
    )
    .get(promptEventId);
  if (otherRow) {
    check(
      "non-fired considered rows stay fired=0 after Stop",
      otherRow.fired === 0,
    );
  }
  db2.close();

  // Timeline now omits the fired row and keeps the unfired considered rows.
  const tlRows2 = await (
    await fetch(`${BASE}/api/claude/timeline?session=${SID}`, {
      headers: { "x-conan-token": TOKEN },
    })
  ).json();
  const stillConsidered = tlRows2.filter(
    (r) => r.kind === "skill-considered" && r.skill === "automate-browser",
  );
  check(
    "Timeline no longer emits automate-browser as considered (now fired)",
    stillConsidered.length === 0,
  );
  const firedTimelineRow = tlRows2.find(
    (r) => r.kind === "skill-fired" && r.skill === "automate-browser",
  );
  check(
    "Timeline emits automate-browser as skill-fired (from transcript scan)",
    !!firedTimelineRow && firedTimelineRow.promptEventId === promptEventId,
  );

  ws.close();
} catch (err) {
  console.log("FAIL - threw (integration):", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
