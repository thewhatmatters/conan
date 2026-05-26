// US-012 test: custom-agents catalog — scan ~/.claude/agents/ (user) + the
// active project's .claude/agents/ (project) for agent definitions, parsing
// {name, description/role, scope, tools?} from each manifest's frontmatter.
//
// Exercises the pure module against a hermetic fake ~/.claude + project dir,
// then the gateway route end-to-end:
//   - flat <name>.md subagent files (frontmatter name/description/tools)
//   - directory manifests (SOUL.md with name/role)
//   - tools parsed from both a comma list and a YAML inline list
//   - user vs project scope distinguished
//   - missing dirs / unreadable / no-frontmatter degrade gracefully (no throw)
//
// Run: tsx scripts/test-agents.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-agents-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const userAgents = path.join(claudeDir, "agents");
const projectDir = path.join(tmp, "project");
const projectAgents = path.join(projectDir, ".claude", "agents");
fs.mkdirSync(userAgents, { recursive: true });
fs.mkdirSync(projectAgents, { recursive: true });

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
fs.mkdirSync(process.env.CONAN_DATA_DIR, { recursive: true });
process.env.CONAN_AUTH_TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
process.env.CONAN_PORT = String(PORT);
// The route's project scope follows the active cwd (persisted to
// $CONAN_DATA_DIR/active-cwd). Seed it to our fake project before the gateway
// (and the cwd module) load.
fs.writeFileSync(path.join(process.env.CONAN_DATA_DIR, "active-cwd"), projectDir);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- user scope: a flat subagent file (comma-list tools) + a SOUL.md dir -----
fs.writeFileSync(
  path.join(userAgents, "code-reviewer.md"),
  `---
name: code-reviewer
description: Reviews diffs for correctness bugs.
tools: Read, Grep, Bash
model: sonnet
---

# Code Reviewer
Body content here.
`,
);
fs.mkdirSync(path.join(userAgents, "chief-of-staff"), { recursive: true });
fs.writeFileSync(
  path.join(userAgents, "chief-of-staff", "SOUL.md"),
  `---
name: Chief of Staff
owner: Randy
role: chief-of-staff
---

# SOUL.md — Chief of Staff
`,
);
// A directory with no manifest → ignored.
fs.mkdirSync(path.join(userAgents, "empty-dir"), { recursive: true });

// --- project scope: a flat file with a YAML inline-list tools ----------------
fs.writeFileSync(
  path.join(projectAgents, "deployer.md"),
  `---
name: deployer
description: "Ships the build."
tools: [Bash, Read]
---

Deploy steps.
`,
);

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/agents/index.ts");

  const r = mod.readAgents({ claudeDir, projectDir });
  check("found 3 agents (2 user + 1 project)", r.agents.length === 3);

  const reviewer = r.agents.find((a) => a.name === "code-reviewer");
  check("flat .md parsed: name + description", reviewer && reviewer.description === "Reviews diffs for correctness bugs.");
  check("comma-list tools parsed", reviewer && Array.isArray(reviewer.tools) && reviewer.tools.join(",") === "Read,Grep,Bash");
  check("user scope on flat file", reviewer && reviewer.scope === "user");

  const cos = r.agents.find((a) => a.name === "Chief of Staff");
  check("SOUL.md dir parsed: name from frontmatter", !!cos);
  check("role surfaced; description falls back to role", cos && cos.role === "chief-of-staff" && cos.description === "chief-of-staff");
  check("no tools → null", cos && cos.tools === null);

  const dep = r.agents.find((a) => a.name === "deployer");
  check("project scope distinguished", dep && dep.scope === "project");
  check("YAML inline-list tools parsed", dep && Array.isArray(dep.tools) && dep.tools.join(",") === "Bash,Read");

  // empty-dir (no manifest) must not appear
  check("dir without manifest ignored", !r.agents.some((a) => a.name === "empty-dir"));

  // missing dirs → empty, no throw
  const empty = mod.readAgents({ claudeDir: path.join(tmp, "nope"), projectDir: path.join(tmp, "nope2") });
  check("missing dirs → empty list", empty.agents.length === 0);

  // file with no frontmatter → still listed, null description, basename name
  const bare = path.join(tmp, "bare-claude", "agents");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "plain.md"), "Just a body, no frontmatter.\n");
  const b = mod.readAgents({ claudeDir: path.join(tmp, "bare-claude"), projectDir: path.join(tmp, "nope3") });
  const plain = b.agents.find((a) => a.name === "plain");
  check("no-frontmatter file → basename name, null fields", plain && plain.description === null && plain.tools === null && plain.role === null);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/agents`)).json();
  check("GET /api/claude/agents returns agents array", Array.isArray(g.agents));
  // user scope reads CONAN_CLAUDE_DIR; project scope reads CONAN_ACTIVE_CWD.
  check("route surfaces user + project agents", g.agents.some((a) => a.name === "code-reviewer") && g.agents.some((a) => a.name === "deployer"));
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
