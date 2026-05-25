// US-003 test: GET /api/claude/mcp — infer MCP status from disk config + an
// optional live-session override. First exercises the pure readMcpStatus()
// against crafted fixture files, then boots the real gateway and drives the
// endpoint (no live session → pure inference) asserting the disk-only path.
//
// Run: tsx scripts/test-mcp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-mcp-test-"));
const dataDir = path.join(tmp, "data");
const fakeHome = path.join(tmp, "home");
const claudeDir = path.join(fakeHome, ".claude");
fs.mkdirSync(claudeDir, { recursive: true });

const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);
process.env.HOME = fakeHome;

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { readMcpStatus } = await import("../src/mcp/index.ts");

  // --- pure helper, all inputs missing -> safe empty shape ----------------
  const empty = readMcpStatus({
    settingsPath: path.join(tmp, "nope-settings.json"),
    needsAuthPath: path.join(tmp, "nope-auth.json"),
    projectMcpPath: path.join(tmp, "nope-mcp.json"),
  });
  check("missing files -> hasData false", empty.hasData === false);
  check("missing files -> no servers", empty.servers.length === 0);
  check("missing files -> zero counts", empty.connectedCount === 0 && empty.configuredCount === 0);

  // --- configured servers, one needing auth -------------------------------
  const settings = path.join(claudeDir, "settings.json");
  const needsAuth = path.join(claudeDir, "mcp-needs-auth-cache.json");
  const projectMcp = path.join(tmp, ".mcp.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({ mcpServers: { obsidian: {}, notion: {} } }),
  );
  fs.writeFileSync(
    needsAuth,
    JSON.stringify({ notion: { timestamp: 123 } }),
  );
  fs.writeFileSync(
    projectMcp,
    JSON.stringify({ mcpServers: { "project-tool": {} } }),
  );

  const inferred = readMcpStatus({
    settingsPath: settings,
    needsAuthPath: needsAuth,
    projectMcpPath: projectMcp,
  });
  check("configured count merges settings + project", inferred.configuredCount === 3);
  check("name-sorted servers", inferred.servers.map((s) => s.name).join(",") === "notion,obsidian,project-tool");
  check("obsidian inferred connected", inferred.servers.find((s) => s.name === "obsidian").status === "connected");
  check("notion in needs-auth cache -> needs-auth", inferred.servers.find((s) => s.name === "notion").status === "needs-auth");
  check("project server inferred connected", inferred.servers.find((s) => s.name === "project-tool").status === "connected");
  check("connectedCount = configured minus needs-auth", inferred.connectedCount === 2);
  check("needsAuthCount counts the cache hit", inferred.needsAuthCount === 1);
  check("no live session -> fromLiveSession false", inferred.fromLiveSession === false);
  check("config source tag", inferred.servers.every((s) => s.source === "config"));

  // --- live session overrides the inference -------------------------------
  const live = readMcpStatus({
    settingsPath: settings,
    needsAuthPath: needsAuth,
    projectMcpPath: projectMcp,
    // obsidian actually failed this run; notion actually connected (auth cleared).
    sessionMcp: [
      { name: "obsidian", status: "failed" },
      { name: "notion", status: "connected" },
    ],
  });
  check("live session sets fromLiveSession", live.fromLiveSession === true);
  check("live override: obsidian -> failed", live.servers.find((s) => s.name === "obsidian").status === "failed");
  check("live override: notion -> connected", live.servers.find((s) => s.name === "notion").status === "connected");
  check("live override tagged source=session", live.servers.find((s) => s.name === "notion").source === "session");
  check("untouched project server stays config", live.servers.find((s) => s.name === "project-tool").source === "config");
  check("connectedCount reflects live override", live.connectedCount === 2); // notion + project-tool
  check("needs-auth empty after live clears it", live.needsAuthCount === 0);

  // status normalization: anything auth-ish -> needs-auth.
  const authish = readMcpStatus({
    settingsPath: path.join(tmp, "nope.json"),
    needsAuthPath: path.join(tmp, "nope.json"),
    projectMcpPath: null,
    sessionMcp: [{ name: "x", status: "needs-authentication" }],
  });
  check("auth-ish session status -> needs-auth", authish.servers[0].status === "needs-auth");

  // --- gateway round-trip (no live session in a fresh DB) -----------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const res = await fetch(`${BASE}/api/claude/mcp`);
  check("endpoint 200", res.status === 200);
  const mcp = await res.json();
  check("endpoint reads configured servers", mcp.configuredCount === 2); // obsidian + notion (no project .mcp.json at cwd)
  check("endpoint applies needs-auth cache", mcp.servers.find((s) => s.name === "notion")?.status === "needs-auth");
  check("endpoint connectedCount = 1 (obsidian)", mcp.connectedCount === 1);
  check("endpoint fromLiveSession false (no active session)", mcp.fromLiveSession === false);
  check("endpoint hasData true", mcp.hasData === true);
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
