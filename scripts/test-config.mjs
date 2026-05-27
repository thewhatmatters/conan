// US-007 test: the read-only Claude /config mirror (src/config/index.ts). Covers
// the pure collectConfig core (project>user precedence, source tagging, absent
// keys omitted not fabricated, global-file rows, malformed file = null data) and
// readClaudeConfig over a temp project fixture (project settings surface as
// Project; the file list reports presence). No real-tree value assertions.
//
// Run: tsx scripts/test-config.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = false;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
  if (!cond) failed = true;
};

try {
  const { collectConfig, readClaudeConfig } = await import("../src/config/index.ts");

  // --- collectConfig pure core -------------------------------------------
  const projectFile = {
    scope: "Project",
    path: "/proj/.claude/settings.json",
    data: { theme: "dark", verbose: true },
  };
  const userFile = {
    scope: "User",
    path: "/home/.claude/settings.json",
    data: { theme: "light", alwaysThinkingEnabled: false, notAKnownKey: 1 },
  };
  const globalFile = {
    scope: "Global",
    path: "/home/.claude.json",
    data: { autoUpdates: true, alsoNotKnown: "x" },
  };

  const entries = collectConfig([projectFile, userFile], globalFile);
  const byKey = (k) => entries.find((e) => e.key === k);

  check("project overrides user (theme tagged Project)", (() => {
    const t = byKey("theme");
    return t && t.value === "dark" && t.source === "Project";
  })());
  check("user-only key tagged User", (() => {
    const a = byKey("alwaysThinkingEnabled");
    return a && a.value === false && a.source === "User";
  })());
  check("project-only key surfaces", (() => {
    const v = byKey("verbose");
    return v && v.value === true && v.source === "Project";
  })());
  check("global-file key tagged Global", (() => {
    const u = byKey("autoUpdates");
    return u && u.value === true && u.source === "Global" && u.sourcePath === "/home/.claude.json";
  })());
  check("unknown keys are not emitted (no fabrication)", byKey("notAKnownKey") === undefined && byKey("alsoNotKnown") === undefined);
  check("absent known key omitted (model unset)", byKey("model") === undefined);
  check("every entry carries label + sourcePath", entries.every(
    (e) => typeof e.label === "string" && e.label.length > 0 && typeof e.sourcePath === "string",
  ));

  // malformed / missing file => null data => its keys drop out
  const noneEntries = collectConfig(
    [{ scope: "Project", path: "/p", data: null }, { scope: "User", path: "/u", data: null }],
    { scope: "Global", path: "/g", data: null },
  );
  check("all-null files yield no entries", noneEntries.length === 0);

  // value present but undefined must not be emitted
  const undefEntries = collectConfig(
    [{ scope: "User", path: "/u", data: { theme: undefined } }],
    { scope: "Global", path: "/g", data: null },
  );
  check("explicit undefined value omitted", undefEntries.find((e) => e.key === "theme") === undefined);

  // --- readClaudeConfig over a temp project fixture ----------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-config-"));
  const projDir = path.join(tmp, ".claude");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, "settings.json"),
    JSON.stringify({ theme: "ProjectTheme123", editorMode: "vim" }),
  );

  const { entries: real, files } = readClaudeConfig(tmp);
  check("project settings.json value surfaces tagged Project", (() => {
    const t = real.find((e) => e.key === "theme");
    return t && t.value === "ProjectTheme123" && t.source === "Project";
  })());
  check("project-only editorMode surfaces", real.some((e) => e.key === "editorMode" && e.value === "vim"));
  check("files list reports the project settings as present", (() => {
    const f = files.find((x) => x.scope === "Project");
    return f && f.present === true && f.path.includes(path.join(".claude", "settings.json"));
  })());
  check("files list always includes User + Global scopes", (() => {
    const scopes = files.map((f) => f.scope);
    return scopes.includes("User") && scopes.includes("Global");
  })());

  fs.rmSync(tmp, { recursive: true, force: true });

  // cwd=null must not throw (no project file consulted)
  const nullCwd = readClaudeConfig(null);
  check("readClaudeConfig(null) returns a shape without throwing",
    Array.isArray(nullCwd.entries) && Array.isArray(nullCwd.files));

  // entries carry their type kind (US-002)
  check("collected entries carry a kind", (() => {
    const t = byKey("theme");
    return t && t.kind === "enum";
  })());

  // --- US-002: editable-config foundation --------------------------------
  const {
    extractEnumFromBinary,
    configSchema,
    keyType,
    validateValue,
    applyConfigWrite,
    writeConfigKey,
  } = await import("../src/config/index.ts");

  // extractEnumFromBinary: anchored flat string array out of a fake "binary"
  const binTmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-bin-"));
  const fakeBin = path.join(binTmp, "fake-claude");
  fs.writeFileSync(
    fakeBin,
    'noise...["dark","light","light-daltonized","dark-daltonized"]...["normal","vim"]...prose "dark-daltonized" elsewhere',
  );
  check("extractEnumFromBinary pulls the array containing the anchor", (() => {
    const v = extractEnumFromBinary(fakeBin, "dark-daltonized");
    return Array.isArray(v) && v.includes("dark") && v.includes("dark-daltonized") && v.length === 4;
  })());
  check("extractEnumFromBinary returns null for an absent anchor",
    extractEnumFromBinary(fakeBin, "no-such-value") === null);
  check("extractEnumFromBinary returns null for a missing binary",
    extractEnumFromBinary(path.join(binTmp, "nope"), "x") === null);
  fs.rmSync(binTmp, { recursive: true, force: true });

  // type metadata: schema shape + per-key kinds
  const schema = configSchema();
  check("schema lists theme as enum, verbose as boolean, model as string", (() => {
    const byK = (k) => schema.find((s) => s.key === k);
    return byK("theme")?.kind === "enum"
      && byK("verbose")?.kind === "boolean"
      && byK("model")?.kind === "string"
      && byK("messageIdleNotifThresholdMs")?.kind === "number";
  })());
  check("global key autoUpdates is in schema with global scope", (() => {
    const u = schema.find((s) => s.key === "autoUpdates");
    return u && u.kind === "boolean" && u.scope === "global";
  })());
  check("keyType('theme') resolves, keyType('bogus') does not",
    keyType("theme")?.kind === "enum" && keyType("permissions") === undefined);

  // validateValue: every kind, pass + reject
  check("validateValue boolean", validateValue("boolean", true).ok && !validateValue("boolean", "x").ok);
  check("validateValue number", validateValue("number", 5000).ok && !validateValue("number", "5000").ok && !validateValue("number", Infinity).ok);
  check("validateValue string", validateValue("string", "claude-opus").ok && !validateValue("string", 1).ok);
  check("validateValue enum (with allowed list)", (() => {
    const allowed = ["dark", "light"];
    return validateValue("enum", "dark", allowed).ok
      && !validateValue("enum", "neon", allowed).ok
      && !validateValue("enum", 1, allowed).ok;
  })());
  check("validateValue enum with no list accepts any string",
    validateValue("enum", "anything").ok);

  // applyConfigWrite: only the one key changes, all others preserved
  const cfgTmp = fs.mkdtempSync(path.join(os.tmpdir(), "conan-write-"));
  const settingsFile = path.join(cfgTmp, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const original = {
    theme: "light",
    verbose: true,
    permissions: { allow: ["Bash(npm:*)"], deny: [] },
    hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] },
    mcpServers: { foo: { command: "bar" } },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));
  applyConfigWrite(settingsFile, "theme", "dark");
  const after = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  check("applyConfigWrite changes only the target key", (() => {
    return after.theme === "dark"
      && after.verbose === true
      && JSON.stringify(after.permissions) === JSON.stringify(original.permissions)
      && JSON.stringify(after.hooks) === JSON.stringify(original.hooks)
      && JSON.stringify(after.mcpServers) === JSON.stringify(original.mcpServers);
  })());

  // writeConfigKey: full route logic against a temp HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "conan-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ verbose: false, permissions: { allow: ["X"] } }, null, 2),
  );
  const wOk = writeConfigKey("verbose", true, home);
  const homeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  check("writeConfigKey writes a boolean to settings.json, preserving permissions",
    wOk.ok && wOk.status === 200 && homeSettings.verbose === true
    && JSON.stringify(homeSettings.permissions) === JSON.stringify({ allow: ["X"] }));
  check("writeConfigKey routes the global key to ~/.claude.json", (() => {
    const r = writeConfigKey("autoUpdates", false, home);
    const g = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    return r.ok && r.file.endsWith(".claude.json") && g.autoUpdates === false;
  })());
  check("writeConfigKey rejects an unknown key with 400",
    (() => { const r = writeConfigKey("permissions", {}, home); return !r.ok && r.status === 400; })());
  check("writeConfigKey rejects a type-mismatched value with 400",
    (() => { const r = writeConfigKey("verbose", "yes", home); return !r.ok && r.status === 400; })());
  check("writeConfigKey rejects a missing key with 400",
    (() => { const r = writeConfigKey(undefined, true, home); return !r.ok && r.status === 400; })());
  fs.rmSync(cfgTmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
