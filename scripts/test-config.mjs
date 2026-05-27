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

  // --- US-012: terminal /theme mirror -----------------------------------
  const { nextClaudeTheme, writeClaudeTheme, readClaudeTheme } = await import(
    "../src/config/index.ts"
  );

  // nextClaudeTheme: flip the base polarity, preserve a matching variant.
  check("nextClaudeTheme flips light->dark", nextClaudeTheme("light", "dark") === "dark");
  check("nextClaudeTheme flips dark->light", nextClaudeTheme("dark", "light") === "light");
  check("nextClaudeTheme preserves dark-daltonized on dark",
    nextClaudeTheme("dark-daltonized", "dark") === "dark-daltonized");
  check("nextClaudeTheme replaces dark-daltonized on light",
    nextClaudeTheme("dark-daltonized", "light") === "light");
  check("nextClaudeTheme handles a missing/non-string current",
    nextClaudeTheme(undefined, "dark") === "dark" && nextClaudeTheme(42, "light") === "light");

  // writeClaudeTheme over a temp settings.json: write, preserve, no-op cases.
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-theme-"));
  const tfile = path.join(tdir, "settings.json");
  fs.writeFileSync(tfile, JSON.stringify({ theme: "light", verbose: true, env: { A: "1" } }));

  const w1 = writeClaudeTheme("dark", tfile);
  const after1 = JSON.parse(fs.readFileSync(tfile, "utf8"));
  check("writeClaudeTheme flips the theme on disk", w1.ok && w1.theme === "dark" && after1.theme === "dark");
  check("writeClaudeTheme preserves the other keys", after1.verbose === true && after1.env?.A === "1");

  // already in sync => ok, no rewrite needed
  const w2 = writeClaudeTheme("dark", tfile);
  check("writeClaudeTheme is an ok no-op when already in sync", w2.ok && w2.theme === "dark");

  // preserves a daltonized variant on a same-polarity mirror
  fs.writeFileSync(tfile, JSON.stringify({ theme: "dark-daltonized" }));
  const w3 = writeClaudeTheme("dark", tfile);
  check("writeClaudeTheme keeps a same-polarity accessibility variant",
    w3.ok && w3.theme === "dark-daltonized");

  // missing file => safe no-op, reflected as not-available
  const missing = path.join(tdir, "nope.json");
  const w4 = writeClaudeTheme("dark", missing);
  check("writeClaudeTheme on a missing config is a safe no-op", w4.ok === false && w4.reason === "no-config");
  check("writeClaudeTheme does not create a missing config", !fs.existsSync(missing));

  // readClaudeTheme reports value + availability
  const r1 = readClaudeTheme(tfile);
  check("readClaudeTheme reports the on-disk theme + available", r1.theme === "dark-daltonized" && r1.available === true);
  const r2 = readClaudeTheme(missing);
  check("readClaudeTheme reports unavailable for a missing config", r2.theme === null && r2.available === false);

  fs.rmSync(tdir, { recursive: true, force: true });
} catch (err) {
  console.log("FAIL - threw:", err?.stack ?? err?.message ?? err);
  failed = true;
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
