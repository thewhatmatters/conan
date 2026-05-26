// US-011 test: plugins — read ~/.claude/plugins/installed_plugins.json +
// known_marketplaces.json + the enabledPlugins map, return installed plugins
// (name@marketplace, version, scope, gitCommitSha, installPath, enabled) +
// marketplaces.
//
// Exercises the pure module against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR), then the gateway route end-to-end:
//   - plugins flattened from the per-install array (multi-scope plugin → 2 rows)
//   - enabled flag from settings.json enabledPlugins; project settings wins
//   - marketplaces parsed (git url + github repo source shapes)
//   - missing files / malformed JSON → empty arrays, no throw
//
// Run: tsx scripts/test-plugins.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-plugins-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const pluginsDir = path.join(claudeDir, "plugins");
const projectDir = path.join(tmp, "project");
fs.mkdirSync(pluginsDir, { recursive: true });
fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });

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

// Seed installed_plugins.json: example-skills installed twice (user + project),
// swift-lsp user-only, a sparse plugin missing optional fields.
fs.writeFileSync(
  path.join(pluginsDir, "installed_plugins.json"),
  JSON.stringify({
    version: 2,
    plugins: {
      "example-skills@anthropic-agent-skills": [
        {
          scope: "user",
          installPath: "/cache/example-skills/abc",
          version: "690f15cac7f7",
          installedAt: "2026-01-05T04:51:19.532Z",
          lastUpdated: "2026-05-20T01:19:26.447Z",
          gitCommitSha: "690f15cac7f7b4c055c5ab109c79ed9259934081",
        },
        {
          scope: "project",
          projectPath: projectDir,
          installPath: "/cache/example-skills/def",
          version: "690f15cac7f7",
          gitCommitSha: "690f15cac7f7b4c055c5ab109c79ed9259934081",
        },
      ],
      "swift-lsp@claude-plugins-official": [
        { scope: "user", installPath: "/cache/swift-lsp", version: "1.0.0", gitCommitSha: "6d37" },
      ],
      "sparse-plugin@some-market": [{ scope: "user" }],
    },
  }),
);

// Marketplaces: a git-url source and a github-repo source.
fs.writeFileSync(
  path.join(pluginsDir, "known_marketplaces.json"),
  JSON.stringify({
    "anthropic-agent-skills": {
      source: { source: "git", url: "https://github.com/anthropics/skills.git" },
      installLocation: "/marketplaces/anthropic-agent-skills",
      lastUpdated: "2026-05-26T03:21:08.490Z",
    },
    "claude-plugins-official": {
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
      installLocation: "/marketplaces/claude-plugins-official",
      lastUpdated: "2026-05-20T14:05:56.481Z",
    },
  }),
);

// enabledPlugins: user settings enables example-skills + swift-lsp; project
// settings enables sparse-plugin (and DISABLES swift-lsp → project wins).
fs.writeFileSync(
  path.join(claudeDir, "settings.json"),
  JSON.stringify({
    enabledPlugins: {
      "example-skills@anthropic-agent-skills": true,
      "swift-lsp@claude-plugins-official": true,
    },
  }),
);
fs.writeFileSync(
  path.join(projectDir, ".claude", "settings.json"),
  JSON.stringify({
    enabledPlugins: {
      "sparse-plugin@some-market": true,
      "swift-lsp@claude-plugins-official": false,
    },
  }),
);

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/plugins/index.ts");

  const r = mod.readPlugins({ claudeDir, projectDir });

  check("installs flattened (2+1+1 = 4 rows)", r.plugins.length === 4);

  const skills = r.plugins.filter((p) => p.id === "example-skills@anthropic-agent-skills");
  check("multi-scope plugin yields 2 rows", skills.length === 2);
  check(
    "name/marketplace split from id",
    skills[0].name === "example-skills" && skills[0].marketplace === "anthropic-agent-skills",
  );
  check("carries version + gitCommitSha + installPath", skills.some((p) => p.version === "690f15cac7f7" && p.gitCommitSha?.startsWith("690f15") && p.installPath === "/cache/example-skills/abc"));
  check("project install carries projectPath + scope", skills.some((p) => p.scope === "project" && p.projectPath === projectDir));
  check("enabled true from user settings", skills.every((p) => p.enabled === true));

  const swift = r.plugins.find((p) => p.id === "swift-lsp@claude-plugins-official");
  check("project settings override wins (swift-lsp disabled)", swift && swift.enabled === false);

  const sparse = r.plugins.find((p) => p.id === "sparse-plugin@some-market");
  check("sparse plugin: missing optional fields → null", sparse && sparse.version === null && sparse.gitCommitSha === null && sparse.projectPath === null);
  check("sparse plugin enabled via project settings", sparse && sparse.enabled === true);

  check("marketplaces parsed (2)", r.marketplaces.length === 2);
  const git = r.marketplaces.find((m) => m.name === "anthropic-agent-skills");
  const gh = r.marketplaces.find((m) => m.name === "claude-plugins-official");
  check("git source url", git && git.sourceType === "git" && git.sourceUrl === "https://github.com/anthropics/skills.git");
  check("github source repo as url", gh && gh.sourceType === "github" && gh.sourceUrl === "anthropics/claude-plugins-official");
  check("marketplace carries installLocation + lastUpdated", git && git.installLocation === "/marketplaces/anthropic-agent-skills" && !!git.lastUpdated);

  // missing files → empty, no throw
  const empty = mod.readPlugins({ claudeDir: path.join(tmp, "nope"), projectDir: path.join(tmp, "nope") });
  check("missing dir → empty arrays", empty.plugins.length === 0 && empty.marketplaces.length === 0);

  // malformed JSON → empty, no throw
  const bad = path.join(tmp, "bad-claude");
  fs.mkdirSync(path.join(bad, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(bad, "plugins", "installed_plugins.json"), "{ not json");
  fs.writeFileSync(path.join(bad, "plugins", "known_marketplaces.json"), "nope");
  const m = mod.readPlugins({ claudeDir: bad, projectDir: bad });
  check("malformed JSON → empty arrays", m.plugins.length === 0 && m.marketplaces.length === 0);

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/plugins`)).json();
  check("GET /api/claude/plugins returns plugins + marketplaces", Array.isArray(g.plugins) && Array.isArray(g.marketplaces) && g.plugins.length === 4 && g.marketplaces.length === 2);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
