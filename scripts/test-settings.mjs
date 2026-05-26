// US-006 test: Claude Code settings mirror (read) + safe write endpoint.
// Exercises the pure settings module against a hermetic fake ~/.claude (via
// CONAN_CLAUDE_DIR / CONAN_CLAUDE_JSON), then the gateway routes end-to-end:
//   - definitions/types come from the bundled canonical schema (defSource)
//   - GET reads value + type + allowed + source across the source files
//   - missing keys fall back to defaults (source "default")
//   - settings.local.json overrides settings.json; ~/.claude.json is a fallback
//   - PUT is token-gated, writes only allowlisted keys, preserves unknown keys,
//     refuses risky keys, and rejects invalid values
//
// Run: tsx scripts/test-settings.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-settings-test-"));
const claudeDir = path.join(tmp, "dot-claude");
const claudeJson = path.join(tmp, "dot-claude.json");
fs.mkdirSync(claudeDir, { recursive: true });

const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.CONAN_CLAUDE_DIR = claudeDir;
process.env.CONAN_CLAUDE_JSON = claudeJson;
process.env.CONAN_DATA_DIR = path.join(tmp, "data");
process.env.CONAN_AUTH_TOKEN = TOKEN;
process.env.CONAN_PORT = String(PORT);

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (key, list) => list.find((s) => s.key === key);

// Seed the fake settings files. settings.json holds base values + an unknown
// key we expect writes to preserve; settings.local.json overrides one of them;
// ~/.claude.json carries a fallback-only value.
fs.writeFileSync(
  path.join(claudeDir, "settings.json"),
  JSON.stringify({
    theme: "dark",
    verbose: false,
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "65" },
    someUnknownKey: { keepMe: true },
  }),
);
fs.writeFileSync(
  path.join(claudeDir, "settings.local.json"),
  JSON.stringify({ theme: "light" }), // overrides settings.json theme
);
fs.writeFileSync(claudeJson, JSON.stringify({ editorMode: "vim" }));

try {
  // --- pure module --------------------------------------------------------
  const mod = await import("../src/settings/index.ts");

  const defs = mod.settingDefs();
  check("settingDefs returns the writable allowlist", [
    "theme",
    "verbose",
    "alwaysThinkingEnabled",
    "editorMode",
    "agentPushNotifEnabled",
    "autoCompactThreshold",
  ].every((k) => defs.some((d) => d.key === k && d.writable)));

  check(
    "alwaysThinkingEnabled definition comes from the canonical schema",
    get("alwaysThinkingEnabled", defs).defSource === "schema",
  );
  check(
    "effortLevel enum comes from the schema with allowed values",
    (() => {
      const d = get("effortLevel", defs);
      return d && d.defSource === "schema" && d.type === "enum" && d.allowed.includes("xhigh");
    })(),
  );

  const read = mod.readClaudeSettings();
  const theme = get("theme", read.settings);
  check("settings.local.json overrides settings.json (theme=light)", theme.value === "light" && theme.source === "settings.local.json");

  const verbose = get("verbose", read.settings);
  check("value read from settings.json (verbose=false)", verbose.value === false && verbose.source === "settings.json");

  const editor = get("editorMode", read.settings);
  check("~/.claude.json is a fallback source (editorMode=vim)", editor.value === "vim" && editor.source === ".claude.json");

  const autocompact = get("autoCompactThreshold", read.settings);
  check("env-pathed integer coerced to number (65)", autocompact.value === 65 && autocompact.type === "integer");

  const pushNotif = get("agentPushNotifEnabled", read.settings);
  check("missing key falls back to default (source=default)", pushNotif.source === "default" && pushNotif.value === false);

  // --- write: validation --------------------------------------------------
  check("write rejects unknown key", mod.writeClaudeSetting("totallyMadeUp", true).ok === false);
  check("write refuses risky key (permissions)", mod.writeClaudeSetting("permissions", {}).status === 403);
  check("write refuses risky key (hooks)", mod.writeClaudeSetting("hooks", {}).status === 403);
  check("write rejects bad enum value", mod.writeClaudeSetting("theme", "chartreuse").ok === false);
  check("write rejects wrong type for boolean", mod.writeClaudeSetting("verbose", "yes").ok === false);
  check("write rejects out-of-range integer", mod.writeClaudeSetting("autoCompactThreshold", 250).ok === false);

  // --- write: success + preserve unknown keys -----------------------------
  const w = mod.writeClaudeSetting("verbose", true);
  check("write accepts a valid boolean", w.ok === true && w.value === true);
  const afterRaw = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  check("write persisted verbose=true", afterRaw.verbose === true);
  check("write preserved the unknown key", afterRaw.someUnknownKey && afterRaw.someUnknownKey.keepMe === true);

  const w2 = mod.writeClaudeSetting("autoCompactThreshold", 70);
  const after2 = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  check("env-pathed integer stored as string under env", w2.ok && after2.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === "70");

  // --- gateway round-trip -------------------------------------------------
  await import("../src/gateway/index.ts");
  await sleep(300);

  const g = await (await fetch(`${BASE}/api/claude/settings`)).json();
  check("GET /api/claude/settings returns the settings array", Array.isArray(g.settings) && g.settings.length > 0);
  check("GET reflects the persisted verbose=true", get("verbose", g.settings).value === true);
  check("GET reports source files", typeof g.sources.settings === "string");

  // PUT without a token is rejected.
  const noAuth = await fetch(`${BASE}/api/claude/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "theme", value: "dark" }),
  });
  check("PUT without token is 401", noAuth.status === 401);

  // PUT an invalid value -> 400 with message.
  const bad = await fetch(`${BASE}/api/claude/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ key: "theme", value: "neon" }),
  });
  const badJson = await bad.json();
  check("PUT invalid value -> 400 with error", bad.status === 400 && typeof badJson.error === "string");

  // PUT a risky key -> 403.
  const risky = await fetch(`${BASE}/api/claude/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ key: "hooks", value: {} }),
  });
  check("PUT risky key -> 403", risky.status === 403);

  // PUT a valid value persists + is visible on the next GET.
  const ok = await fetch(`${BASE}/api/claude/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-conan-token": TOKEN },
    body: JSON.stringify({ key: "editorMode", value: "vim" }),
  });
  const okJson = await ok.json();
  check("PUT valid value -> ok", ok.ok && okJson.value === "vim");
  const g2 = await (await fetch(`${BASE}/api/claude/settings`)).json();
  check("GET reflects the PUT (editorMode now from settings.json)", (() => {
    const e = get("editorMode", g2.settings);
    return e.value === "vim" && e.source === "settings.json";
  })());
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
