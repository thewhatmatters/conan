// US-016 test: skills catalog — scan ~/.claude/skills/*/SKILL.md (user) + the
// active project's .claude/skills/*/SKILL.md (project), parsing {name,
// description, scope} from each SKILL.md frontmatter, plus a `loaded` flag
// derived from a session's system/init slash_commands.
//
// Exercises the pure module against a hermetic fake ~/.claude + project dir,
// then the gateway route end-to-end:
//   - frontmatter name + description parsed; basename fallback when absent
//   - user vs project scope distinguished + stable ordering
//   - dirs without SKILL.md ignored
//   - loaded flag: true/false per skill from a session's slash_commands,
//     null when no session / no init event; namespaced commands match bare names
//   - missing dirs degrade gracefully (no throw)
//
// Run: tsx scripts/test-skills-list.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-skills-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const userSkills = path.join(claudeDir, "skills");
const projectDir = path.join(tmp, "project");
const projectSkills = path.join(projectDir, ".claude", "skills");
fs.mkdirSync(userSkills, { recursive: true });
fs.mkdirSync(projectSkills, { recursive: true });

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.CONAN_DATA_DIR, { recursive: true });
process.env.CONAN_AUTH_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
process.env.CONAN_PORT = String(PORT);
// The route's project scope follows the active cwd (persisted to
// $CONAN_DATA_DIR/active-cwd). Seed it before the gateway + cwd module load.
fs.writeFileSync(path.join(process.env.CONAN_DATA_DIR, "active-cwd"), projectDir);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- user scope: two skills with frontmatter, one dir without SKILL.md -------
const mkSkill = (root, dir, name, description) => {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  const fm = ["---", `name: ${name}`];
  if (description != null) fm.push(`description: ${description}`);
  fm.push("---", "", `# ${name}`, "Body.");
  fs.writeFileSync(path.join(root, dir, "SKILL.md"), fm.join("\n") + "\n");
};
mkSkill(userSkills, "verify", "verify", "Verify a change actually works.");
mkSkill(userSkills, "handoff", "handoff", "Write a resume-ready HANDOFF.md.");
fs.mkdirSync(path.join(userSkills, "not-a-skill"), { recursive: true }); // no SKILL.md

// --- project scope: one skill, and one with no frontmatter -------------------
mkSkill(projectSkills, "deploy", "deploy", "Ship the build.");
fs.mkdirSync(path.join(projectSkills, "bare"), { recursive: true });
fs.writeFileSync(path.join(projectSkills, "bare", "SKILL.md"), "Just a body, no frontmatter.\n");

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/skills/index.ts");

  const r = mod.listSkills({ claudeDir, projectDir });
  check("found 4 skills (2 user + 2 project)", r.skills.length === 4);

  const verify = r.skills.find((s) => s.name === "verify");
  check("frontmatter name + description parsed", verify && verify.description === "Verify a change actually works.");
  check("user scope on global skill", verify && verify.scope === "user");

  const deploy = r.skills.find((s) => s.name === "deploy");
  check("project scope distinguished", deploy && deploy.scope === "project");

  const bare = r.skills.find((s) => s.name === "bare");
  check("no-frontmatter SKILL.md → basename name, null description", bare && bare.description === null);

  check("dir without SKILL.md ignored", !r.skills.some((s) => s.name === "not-a-skill"));
  check("user scope ordered before project", r.skills[0].scope === "user" && r.skills[r.skills.length - 1].scope === "project");

  // no session → loaded is null for every skill
  check("no session → loaded null", r.skills.every((s) => s.loaded === null));

  // missing dirs → empty, no throw
  const empty = mod.listSkills({ claudeDir: path.join(tmp, "nope"), projectDir: path.join(tmp, "nope2") });
  check("missing dirs → empty list", empty.skills.length === 0);

  // --- loaded flag from a session's system/init slash_commands ------------
  const { getDb } = await import("../src/db/index.ts");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO session (id, status, created_at, last_activity) VALUES (?, 'idle', ?, ?)`,
  ).run("a1b2c3d4-loaded", now, now);
  // slash_commands carries a bare name (verify) and a namespaced one whose last
  // segment matches a skill (plugin:deploy). handoff is NOT loaded.
  db.prepare(
    `INSERT INTO event (session_id, stream_type, payload, ts) VALUES (?, 'system/init', ?, ?)`,
  ).run("a1b2c3d4-loaded", JSON.stringify({ slash_commands: ["verify", "plugin:deploy", "help"] }), now);

  const withSession = mod.listSkills({ claudeDir, projectDir, sessionId: "a1b2c3d4-loaded" });
  const lVerify = withSession.skills.find((s) => s.name === "verify");
  const lDeploy = withSession.skills.find((s) => s.name === "deploy");
  const lHandoff = withSession.skills.find((s) => s.name === "handoff");
  check("loaded true for a bare-name match", lVerify && lVerify.loaded === true);
  check("loaded true via namespaced last-segment match", lDeploy && lDeploy.loaded === true);
  check("loaded false for an unloaded skill", lHandoff && lHandoff.loaded === false);

  // session with no init event → loaded null
  db.prepare(
    `INSERT INTO session (id, status, created_at, last_activity) VALUES (?, 'idle', ?, ?)`,
  ).run("e5f6a7b8-noinit", now, now);
  const noInit = mod.listSkills({ claudeDir, projectDir, sessionId: "e5f6a7b8-noinit" });
  check("session without init event → loaded null", noInit.skills.every((s) => s.loaded === null));

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/skills/list`)).json();
  check("GET /api/claude/skills/list returns skills array", Array.isArray(g.skills));
  check("route surfaces user + project skills", g.skills.some((s) => s.name === "verify") && g.skills.some((s) => s.name === "deploy"));

  const gs = await (await fetch(`${BASE}/api/claude/skills/list?session_id=a1b2c3d4-loaded`)).json();
  check("GET ?session_id= annotates loaded", gs.skills.find((s) => s.name === "verify")?.loaded === true && gs.skills.find((s) => s.name === "handoff")?.loaded === false);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
