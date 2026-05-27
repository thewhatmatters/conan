// US-007: read-only mirror of Claude Code's `/config`. The interactive `/config`
// TUI is the only place these settings surface inside Claude Code; there is no
// `claude config` dump we can shell out to. But the rows it shows are persisted
// to JSON on disk, so Conan reads those files and reconstructs a known key/value
// set, each value tagged with the file (scope) it came from. Read-only this loop
// (editing is deferred — the row→file→key mapping below is the foundation for it).
//
// Files (precedence high→low, mirroring how Claude Code merges them):
//   - Project  <cwd>/.claude/settings.json   (per-repo overrides)
//   - User     ~/.claude/settings.json        (your global settings.json)
//   - Global   ~/.claude.json                 (the CLI's own state file)
//
// /config-row → file → key mapping (the confident set). A registry entry is the
// CLAIM that a key maps to a real `/config` row; an entry is only EMITTED when a
// value is actually present in one of its files — absent keys are omitted, never
// fabricated, and keys we can't confidently tie to a `/config` row aren't in the
// registry at all. settings.json rows are read project-then-user (first hit wins,
// matching Claude Code's override order); the few CLI-state rows live in
// ~/.claude.json. Object-valued config-file-only concerns (hooks, permissions,
// mcpServers, statusLine) are intentionally excluded — `/config` doesn't surface
// them as scalar rows, so mapping them would be a guess.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

/** Which file a config value was read from. */
export type ConfigScope = "Project" | "User" | "Global";

/** One config row mirrored from Claude Code, tagged with where it was read. */
export interface ConfigEntry {
  /** The on-disk key (e.g. "theme", "alwaysThinkingEnabled"). */
  key: string;
  /** Human label as the `/config` screen presents the row. */
  label: string;
  /** The parsed value (scalar in practice; never fabricated). */
  value: unknown;
  /** Which file supplied the value. */
  source: ConfigScope;
  /** Absolute path of that file (for the "managed by Claude Code" affordance). */
  sourcePath: string;
}

/** A parsed config file (or null when absent/malformed) plus its scope + path. */
export interface ConfigFile {
  scope: ConfigScope;
  path: string;
  data: Record<string, unknown> | null;
}

/** A confidently-mapped `/config` row: a settings key and its display label. */
interface KnownKey {
  key: string;
  label: string;
}

/**
 * settings.json rows (~/.claude/settings.json and <cwd>/.claude/settings.json).
 * These are documented Claude Code settings that the `/config` TUI surfaces.
 * Read project-then-user so a per-repo override is reported as Project.
 */
const SETTINGS_KEYS: KnownKey[] = [
  { key: "theme", label: "Theme" },
  { key: "alwaysThinkingEnabled", label: "Always thinking" },
  { key: "verbose", label: "Verbose output" },
  { key: "autoCompactEnabled", label: "Auto-compact" },
  { key: "editorMode", label: "Editor mode" },
  { key: "todoFeatureEnabled", label: "Todo list" },
  { key: "messageIdleNotifThresholdMs", label: "Notify after idle (ms)" },
  { key: "preferredNotifChannel", label: "Notification channel" },
  { key: "spinnerTipsEnabled", label: "Spinner tips" },
  { key: "diffTool", label: "Diff tool" },
  { key: "outputStyle", label: "Output style" },
  { key: "includeCoAuthoredBy", label: "Include co-authored-by" },
  { key: "model", label: "Model" },
];

/** ~/.claude.json (the CLI's own state file) rows that map to a `/config` row. */
const GLOBAL_KEYS: KnownKey[] = [
  { key: "autoUpdates", label: "Auto-updates" },
];

/** Parse a JSON file into an object, or null on any failure (absent/malformed). */
function readJson(file: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when a JSON object actually carries a (non-undefined) value for `key`. */
function has(data: Record<string, unknown> | null, key: string): boolean {
  return data != null && Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;
}

/**
 * Pure core: resolve the known key set against already-parsed files. settings.json
 * keys are looked up across the settings-scoped files in precedence order (first
 * hit wins); global keys come from the ~/.claude.json file. A key absent from all
 * its candidate files is omitted entirely — never emitted with a placeholder.
 */
export function collectConfig(
  settingsFiles: ConfigFile[],
  globalFile: ConfigFile,
): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  for (const { key, label } of SETTINGS_KEYS) {
    const hit = settingsFiles.find((f) => has(f.data, key));
    if (hit) {
      out.push({ key, label, value: hit.data![key], source: hit.scope, sourcePath: hit.path });
    }
  }
  for (const { key, label } of GLOBAL_KEYS) {
    if (has(globalFile.data, key)) {
      out.push({ key, label, value: globalFile.data![key], source: globalFile.scope, sourcePath: globalFile.path });
    }
  }
  return out;
}

/**
 * Read Claude Code's config from disk into the confidently-mapped row set
 * (read-only). Project settings override user settings; ~/.claude.json supplies
 * the CLI-state rows. Returns the entries plus the files consulted (with whether
 * each was found) so the UI can show what was read.
 */
export function readClaudeConfig(cwd: string | null): {
  entries: ConfigEntry[];
  files: { scope: ConfigScope; path: string; present: boolean }[];
} {
  const userSettingsPath = path.join(HOME, ".claude", "settings.json");
  const globalPath = path.join(HOME, ".claude.json");
  const projectSettingsPath = cwd ? path.join(cwd, ".claude", "settings.json") : null;

  // Precedence high→low: project settings beat user settings.
  const settingsFiles: ConfigFile[] = [];
  if (projectSettingsPath) {
    settingsFiles.push({ scope: "Project", path: projectSettingsPath, data: readJson(projectSettingsPath) });
  }
  settingsFiles.push({ scope: "User", path: userSettingsPath, data: readJson(userSettingsPath) });
  const globalFile: ConfigFile = { scope: "Global", path: globalPath, data: readJson(globalPath) };

  const entries = collectConfig(settingsFiles, globalFile);
  const files = [...settingsFiles, globalFile].map((f) => ({
    scope: f.scope,
    path: f.path,
    present: f.data != null,
  }));
  return { entries, files };
}

// ── US-012: mirror Conan's app theme into Claude Code's terminal /theme ──────
//
// Mechanism: a config-write of the same `theme` key /config reads above — NOT a
// `/theme` keystroke inject into the pty. Why the file path is the non-fragile
// one: Claude's `/theme` is an interactive arrow-key SELECTOR TUI with no
// argument form, so injecting it means guessing arrow presses from a cursor
// whose start position depends on the current theme (which we can't introspect)
// — a misfire silently picks the wrong theme. Writing the key is deterministic
// and non-destructive. The accepted tradeoff: a *running* `claude` reads `theme`
// at startup and does NOT hot-reload settings.json, so the mirror lands in the
// session's next start, not live. Precondition (so the mirror is a safe no-op):
// ~/.claude/settings.json must already exist — a missing/unreadable file is left
// untouched (we never fabricate the user's config to plant a theme in it).

/** The resolved Conan polarity we drive — Claude's vocabulary is richer. */
export type ConanTheme = "light" | "dark";

/** Result of a mirror attempt, reflected back to the UI (so a no-op is honest). */
export interface ThemeMirrorResult {
  ok: boolean;
  /** The Claude theme value now on disk (when ok). */
  theme?: string;
  /** Why it was a no-op (when !ok). */
  reason?: "no-config" | "write-error";
  /** The settings.json path consulted. */
  path: string;
}

/** ~/.claude/settings.json — where Claude Code persists the `theme` /config row. */
const USER_SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");

/**
 * The Claude theme value to write for a given Conan polarity, given the current
 * on-disk value. Preserves an accessibility variant (daltonized/ansi) whose
 * polarity already matches — we only flip the light/dark base, never clobber a
 * "dark-daltonized" down to a plain "dark". Pure; unit-tested.
 */
export function nextClaudeTheme(current: unknown, conan: ConanTheme): string {
  return typeof current === "string" && current.startsWith(conan) ? current : conan;
}

/** Read the current terminal theme + whether the config exists (for UI state). */
export function readClaudeTheme(file: string = USER_SETTINGS_PATH): {
  theme: string | null;
  available: boolean;
  path: string;
} {
  const data = readJson(file);
  return {
    theme: data && typeof data.theme === "string" ? data.theme : null,
    available: data != null,
    path: file,
  };
}

/**
 * Mirror a Conan theme into Claude Code's `theme` setting (read-modify-write,
 * preserving every other key). No-op when settings.json is absent/unreadable, or
 * already in sync. Returns the outcome so the UI can reflect a no-op honestly.
 */
export function writeClaudeTheme(
  conan: ConanTheme,
  file: string = USER_SETTINGS_PATH,
): ThemeMirrorResult {
  const data = readJson(file);
  if (data == null) return { ok: false, reason: "no-config", path: file };
  const value = nextClaudeTheme(data.theme, conan);
  if (data.theme === value) return { ok: true, theme: value, path: file };
  try {
    fs.writeFileSync(file, JSON.stringify({ ...data, theme: value }, null, 2) + "\n");
    return { ok: true, theme: value, path: file };
  } catch {
    return { ok: false, reason: "write-error", path: file };
  }
}
