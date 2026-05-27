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
import { execFileSync } from "node:child_process";
import { HOME } from "../paths.js";

/** Which file a config value was read from. */
export type ConfigScope = "Project" | "User" | "Global";

/** How a config value is typed (drives the editable control the UI renders). */
export type ConfigKind = "boolean" | "enum" | "string" | "number";

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
  /** The value's type (so the UI knows which editable control to render). */
  kind: ConfigKind;
}

/** A parsed config file (or null when absent/malformed) plus its scope + path. */
export interface ConfigFile {
  scope: ConfigScope;
  path: string;
  data: Record<string, unknown> | null;
}

/**
 * A confidently-mapped `/config` row: a settings key, its display label, and the
 * type metadata that lets the UI render the right editable control (US-002).
 * Enum keys carry an `enumAnchor`: a distinctive member value used to locate the
 * key's allowed-values array inside the claude binary, so the enum set is
 * extracted from the binary (the source of truth) rather than hand-guessed.
 */
interface KnownKey {
  key: string;
  label: string;
  kind: ConfigKind;
  /** For `kind: "enum"`, a distinctive value to anchor the binary extraction. */
  enumAnchor?: string;
}

/**
 * settings.json rows (~/.claude/settings.json and <cwd>/.claude/settings.json).
 * These are documented Claude Code settings that the `/config` TUI surfaces.
 * Read project-then-user so a per-repo override is reported as Project.
 */
const SETTINGS_KEYS: KnownKey[] = [
  { key: "theme", label: "Theme", kind: "enum", enumAnchor: "dark-daltonized" },
  { key: "alwaysThinkingEnabled", label: "Always thinking", kind: "boolean" },
  { key: "verbose", label: "Verbose output", kind: "boolean" },
  { key: "autoCompactEnabled", label: "Auto-compact", kind: "boolean" },
  { key: "editorMode", label: "Editor mode", kind: "enum", enumAnchor: "vim" },
  { key: "todoFeatureEnabled", label: "Todo list", kind: "boolean" },
  { key: "messageIdleNotifThresholdMs", label: "Notify after idle (ms)", kind: "number" },
  { key: "preferredNotifChannel", label: "Notification channel", kind: "string" },
  { key: "spinnerTipsEnabled", label: "Spinner tips", kind: "boolean" },
  { key: "diffTool", label: "Diff tool", kind: "string" },
  { key: "outputStyle", label: "Output style", kind: "string" },
  { key: "includeCoAuthoredBy", label: "Include co-authored-by", kind: "boolean" },
  { key: "model", label: "Model", kind: "string" },
];

/** ~/.claude.json (the CLI's own state file) rows that map to a `/config` row. */
const GLOBAL_KEYS: KnownKey[] = [
  { key: "autoUpdates", label: "Auto-updates", kind: "boolean" },
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
  for (const { key, label, kind } of SETTINGS_KEYS) {
    const hit = settingsFiles.find((f) => has(f.data, key));
    if (hit) {
      out.push({ key, label, kind, value: hit.data![key], source: hit.scope, sourcePath: hit.path });
    }
  }
  for (const { key, label, kind } of GLOBAL_KEYS) {
    if (has(globalFile.data, key)) {
      out.push({ key, label, kind, value: globalFile.data![key], source: globalFile.scope, sourcePath: globalFile.path });
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

// ---------------------------------------------------------------------------
// Editable-config foundation (US-002)
// ---------------------------------------------------------------------------
// The read-only mirror above tells the UI *what* a value is; this layer tells it
// the value's TYPE (so it can render a switch/dropdown/input) and provides a
// safe single-key write. Two non-negotiables:
//   1. Enum allowed-values are EXTRACTED from the claude binary (the source of
//      truth), never hand-typed — so they track the installed Claude Code version.
//   2. The write is a read-modify-write that touches exactly one key and leaves
//      every other key (permissions, hooks, mcpServers, …) intact.

/** Which on-disk file a key is written to. */
type KeyScope = "settings" | "global";

/** Type metadata for one editable key (enum `values` resolved from the binary). */
export interface KeyType {
  key: string;
  label: string;
  kind: ConfigKind;
  /** Target file for writes: User settings.json vs the global ~/.claude.json. */
  scope: KeyScope;
  /** Allowed values for `kind: "enum"` (extracted from the claude binary). */
  values?: string[];
}

/** The editable key registry: settings.json keys + the ~/.claude.json key. */
const EDITABLE_KEYS: (KnownKey & { scope: KeyScope })[] = [
  ...SETTINGS_KEYS.map((k) => ({ ...k, scope: "settings" as const })),
  ...GLOBAL_KEYS.map((k) => ({ ...k, scope: "global" as const })),
];

/** Resolve the absolute claude binary (env override → `which claude`), or null. */
function resolveClaudeBinary(): string | null {
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) {
    try { return fs.realpathSync(fromEnv); } catch { return fromEnv; }
  }
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return p ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

/**
 * Extract a key's enum allowed-values from the claude binary by locating the flat
 * string-literal array `["a","b",…]` that contains `anchor` as a member. Scans
 * each occurrence of the anchor, requires the enclosing brackets to enclose a
 * clean flat array (no prose/false hits), and returns its members. Null when the
 * binary or a matching array can't be found — callers then fall back to a free
 * string control rather than fabricating a list.
 */
export function extractEnumFromBinary(binPath: string, anchor: string): string[] | null {
  try {
    const buf = fs.readFileSync(binPath);
    const needle = Buffer.from(`"${anchor}"`, "latin1");
    let from = 0;
    for (let i = 0; i < 200; i++) {
      const idx = buf.indexOf(needle, from);
      if (idx < 0) break;
      from = idx + needle.length;
      const start = buf.lastIndexOf(0x5b, idx); // '['
      const end = buf.indexOf(0x5d, idx); // ']'
      if (start < 0 || end < 0 || end <= start || end - start > 4096) continue;
      const slice = buf.toString("latin1", start, end + 1);
      if (!/^\["[A-Za-z0-9_-]+"(,"[A-Za-z0-9_-]+")*\]$/.test(slice)) continue;
      const vals = [...slice.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
      if (vals.includes(anchor)) return vals;
    }
    return null;
  } catch {
    return null;
  }
}

// Enum extraction is stable per claude version but costs a binary read, so cache
// per anchor for the process lifetime.
const enumCache = new Map<string, string[] | null>();
function enumValuesFor(anchor: string): string[] | null {
  if (enumCache.has(anchor)) return enumCache.get(anchor)!;
  const bin = resolveClaudeBinary();
  const vals = bin ? extractEnumFromBinary(bin, anchor) : null;
  enumCache.set(anchor, vals);
  return vals;
}

/**
 * The editable-key schema with type metadata, including enum `values` resolved
 * from the binary. This is what GET /api/claude/config exposes so the UI can
 * render the correct control per key (US-002 / US-009 / US-010).
 */
export function configSchema(): KeyType[] {
  return EDITABLE_KEYS.map(({ key, label, kind, enumAnchor, scope }) => {
    const t: KeyType = { key, label, kind, scope };
    if (kind === "enum" && enumAnchor) {
      const values = enumValuesFor(enumAnchor);
      if (values) t.values = values;
    }
    return t;
  });
}

/** Look up the editable type metadata for a single key (undefined if not editable). */
export function keyType(key: string): KeyType | undefined {
  return configSchema().find((t) => t.key === key);
}

/** Result of validating a proposed write: ok, or a human-readable reason. */
export interface ValidateResult {
  ok: boolean;
  error?: string;
}

/**
 * Pure validation of a proposed value against a key's type. Enum values must be
 * supplied by the caller (extracted from the binary) so this stays testable
 * without the binary. Rejects type mismatches with a clear message.
 */
export function validateValue(kind: ConfigKind, value: unknown, enumValues?: string[]): ValidateResult {
  switch (kind) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true } : { ok: false, error: "expected a boolean" };
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, error: "expected a finite number" };
    case "string":
      return typeof value === "string" ? { ok: true } : { ok: false, error: "expected a string" };
    case "enum":
      if (typeof value !== "string") return { ok: false, error: "expected a string" };
      if (!enumValues || enumValues.length === 0) {
        // No allowed-values list available — accept any string rather than block.
        return { ok: true };
      }
      return enumValues.includes(value)
        ? { ok: true }
        : { ok: false, error: `must be one of: ${enumValues.join(", ")}` };
    default:
      return { ok: false, error: "unknown type" };
  }
}

/**
 * Read-modify-write a single key into `file`, preserving every other key. Reads
 * the existing JSON (or starts from {} when absent/malformed-but-replaceable),
 * sets one key, and writes it back pretty-printed. Exported (with an explicit
 * file path) so tests can assert only the one key changed.
 */
export function applyConfigWrite(file: string, key: string, value: unknown): void {
  const data = readJson(file) ?? {};
  data[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Result of a config write attempt routed through the editable schema. */
export interface WriteConfigResult {
  ok: boolean;
  status: number;
  error?: string;
  key?: string;
  value?: unknown;
  file?: string;
}

/**
 * Validate + write one editable key. Rejects unknown keys and type-mismatched
 * values with a 4xx; never writes a key absent from the editable schema. Settings
 * keys land in ~/.claude/settings.json, the global key in ~/.claude.json. The
 * `home` override lets tests target a temp tree.
 */
export function writeConfigKey(key: unknown, value: unknown, home: string = HOME): WriteConfigResult {
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, status: 400, error: "missing or invalid 'key'" };
  }
  const t = keyType(key);
  if (!t) {
    return { ok: false, status: 400, error: `unknown or non-editable key: ${key}` };
  }
  const v = validateValue(t.kind, value, t.values);
  if (!v.ok) {
    return { ok: false, status: 400, error: `invalid value for ${key}: ${v.error}` };
  }
  const file =
    t.scope === "global"
      ? path.join(home, ".claude.json")
      : path.join(home, ".claude", "settings.json");
  try {
    applyConfigWrite(file, key, value);
  } catch (err) {
    return { ok: false, status: 500, error: `failed to write ${file}: ${(err as Error).message}` };
  }
  return { ok: true, status: 200, key, value, file };
}
