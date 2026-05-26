// US-020: read-only settings surface for the Settings view.
//
// The Settings view consolidates *informational* configuration: which Claude
// Code lifecycle hooks are wired (so observed sessions self-report), and the
// remote-access (TLS) posture. There is intentionally NO cost-ceiling/budget
// here — that was removed in US-004/US-014; the plan is token-based, not
// dollar-metered. Theme + usage/plan preferences are client-side.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT, HOME } from "../paths.js";

/** The Claude Code hook events Conan listens for (mirrors conan-hooks.example.json). */
const KNOWN_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "PreCompact",
  "SubagentStop",
  "Stop",
] as const;

export interface HooksStatus {
  /** True when at least one Conan event hook is wired in a settings.json. */
  installed: boolean;
  /** Which known lifecycle events have a hook configured. */
  events: string[];
  /** Where the wired hooks were found (project .claude or ~/.claude), if any. */
  source: string | null;
}

/** Parse a Claude Code settings.json and return which known hook events it wires. */
function hookEventsFrom(file: string): string[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const json = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = json.hooks ?? {};
    return KNOWN_HOOK_EVENTS.filter((e) => Array.isArray(hooks[e]) && (hooks[e] as unknown[]).length > 0);
  } catch {
    return [];
  }
}

/**
 * Resolve hook status from the project's .claude/settings.json first (the one
 * shipped in this repo), falling back to the user's ~/.claude/settings.json.
 * Returns the first source that wires any known event.
 */
export function readHooksStatus(): HooksStatus {
  const candidates: { source: string; file: string }[] = [
    { source: "project .claude", file: path.join(PACKAGE_ROOT, ".claude", "settings.json") },
    { source: "~/.claude", file: path.join(HOME, ".claude", "settings.json") },
  ];
  for (const { source, file } of candidates) {
    const events = hookEventsFrom(file);
    if (events.length > 0) return { installed: true, events, source };
  }
  return { installed: false, events: [], source: null };
}

// ---------------------------------------------------------------------------
// US-006: Claude Code settings mirror (read) + safe write endpoint.
//
// The Settings page (US-029) mirrors Claude Code's own /settings. We read the
// real values from ~/.claude/settings.json (+ settings.local.json overrides, +
// a couple of ~/.claude.json flags) and report each known setting's value,
// type, allowed values, and which file it came from (or "default" when unset).
//
// Setting *definitions* (type/enum/default) are sourced from the canonical
// schema bundled at ./claude-code-settings.schema.json
// (json.schemastore.org/claude-code-settings.json) — never guessed. A few
// long-standing TUI settings (theme, verbose, editorMode, …) are absent from
// that public snapshot; those carry an explicit builtin definition flagged
// `defSource:"builtin"` so the provenance stays honest.
//
// Writes are deliberately narrow: a token-gated PUT may set only an allowlisted
// subset of low-risk preference keys, written atomically to settings.json with
// every unknown key preserved. Risky surfaces (permissions.*, hooks,
// mcpServers) and ~/.claude.json are refused outright.

export type SettingType = "boolean" | "enum" | "string" | "integer";

export interface SettingDef {
  /** Stable logical id surfaced to the UI / write API. */
  key: string;
  /** Location within the settings JSON (dot-path components). */
  path: string[];
  type: SettingType;
  /** Allowed values for an enum. */
  allowed?: string[];
  /** Inclusive bounds for an integer. */
  min?: number;
  max?: number;
  default: unknown;
  /** Whether the safe-write endpoint accepts this key. */
  writable: boolean;
  /** Where the type/allowed/default came from: the canonical schema or a builtin supplement. */
  defSource: "schema" | "builtin";
  description?: string;
}

export interface SettingValue {
  key: string;
  value: unknown;
  type: SettingType;
  allowed?: string[];
  min?: number;
  max?: number;
  default: unknown;
  writable: boolean;
  defSource: "schema" | "builtin";
  description?: string;
  /** Basename of the file the value was read from, or "default" when unset. */
  source: string;
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}
/** The ~/.claude.json file (overridable for tests via CONAN_CLAUDE_JSON). */
function dotClaudeJson(): string {
  return process.env.CONAN_CLAUDE_JSON ?? path.join(HOME, ".claude.json");
}
function settingsFile(): string {
  return path.join(claudeDir(), "settings.json");
}
function settingsLocalFile(): string {
  return path.join(claudeDir(), "settings.local.json");
}

let schemaCache: Record<string, unknown> | null | undefined;
/** Load the bundled canonical schema's `properties` map (cached; null if absent). */
function schemaProps(): Record<string, unknown> | null {
  if (schemaCache !== undefined) return schemaCache;
  try {
    const file = fileURLToPath(
      new URL("./claude-code-settings.schema.json", import.meta.url),
    );
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
      properties?: Record<string, unknown>;
    };
    schemaCache = json.properties ?? null;
  } catch {
    schemaCache = null;
  }
  return schemaCache;
}

/** Derive a {type, allowed, default} fragment from the canonical schema, or null. */
function defFromSchema(
  key: string,
): { type: SettingType; allowed?: string[]; default?: unknown } | null {
  const props = schemaProps();
  const p = props?.[key] as
    | { type?: string; enum?: unknown[]; default?: unknown }
    | undefined;
  if (!p) return null;
  if (Array.isArray(p.enum)) {
    return { type: "enum", allowed: p.enum.map(String), default: p.default };
  }
  switch (p.type) {
    case "boolean":
      return { type: "boolean", default: p.default };
    case "integer":
    case "number":
      return { type: "integer", default: p.default };
    case "string":
      return { type: "string", default: p.default };
    default:
      return null;
  }
}

// The settings Conan surfaces. Definitions prefer the canonical schema; entries
// for keys absent from the public schema snapshot carry a builtin fallback.
// `writable` marks the safe, low-risk preference allowlist (US-006 criteria).
interface RegistryEntry {
  key: string;
  path: string[];
  writable: boolean;
  /** Schema key to pull the canonical definition from (defaults to `key`). */
  schemaKey?: string;
  /** Builtin definition used when the schema lacks the key. */
  builtin?: {
    type: SettingType;
    allowed?: string[];
    min?: number;
    max?: number;
    default: unknown;
  };
  description?: string;
}

const REGISTRY: RegistryEntry[] = [
  // --- safe, writable preference allowlist ---------------------------------
  {
    key: "theme",
    path: ["theme"],
    writable: true,
    builtin: {
      type: "enum",
      allowed: ["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"],
      default: "dark",
    },
    description: "Color theme for the Claude Code TUI.",
  },
  {
    key: "verbose",
    path: ["verbose"],
    writable: true,
    builtin: { type: "boolean", default: false },
    description: "Show full command output instead of truncating.",
  },
  {
    key: "alwaysThinkingEnabled",
    path: ["alwaysThinkingEnabled"],
    writable: true,
    description: "Enable extended thinking by default for all sessions.",
  },
  {
    key: "editorMode",
    path: ["editorMode"],
    writable: true,
    builtin: { type: "enum", allowed: ["normal", "vim"], default: "normal" },
    description: "Prompt editor keybindings.",
  },
  {
    key: "agentPushNotifEnabled",
    path: ["agentPushNotifEnabled"],
    writable: true,
    builtin: { type: "boolean", default: false },
    description: "Send a push notification when an agent finishes.",
  },
  {
    key: "autoCompactThreshold",
    path: ["env", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"],
    writable: true,
    builtin: { type: "integer", min: 0, max: 100, default: 80 },
    description: "Context-usage % at which auto-compaction triggers (env override).",
  },
  // --- read-only, schema-defined extras (page content) ---------------------
  { key: "model", path: ["model"], writable: false, description: "Default model." },
  { key: "effortLevel", path: ["effortLevel"], writable: false, description: "Default reasoning effort." },
  { key: "outputStyle", path: ["outputStyle"], writable: false, description: "Default output style." },
  { key: "includeCoAuthoredBy", path: ["includeCoAuthoredBy"], writable: false, description: "Add Co-Authored-By trailer to commits." },
  { key: "cleanupPeriodDays", path: ["cleanupPeriodDays"], writable: false, description: "Days to retain chat transcripts." },
  { key: "autoUpdatesChannel", path: ["autoUpdatesChannel"], writable: false, description: "Auto-update release channel." },
];

/** Resolve a registry entry into a full definition (schema first, builtin fallback). */
function resolveDef(e: RegistryEntry): SettingDef {
  const fromSchema = defFromSchema(e.schemaKey ?? e.key);
  if (fromSchema && !e.builtin) {
    return {
      key: e.key,
      path: e.path,
      type: fromSchema.type,
      allowed: fromSchema.allowed,
      default: fromSchema.default,
      writable: e.writable,
      defSource: "schema",
      description: e.description,
    };
  }
  // Prefer schema when both exist (canonical), but keep builtin bounds/allowed.
  if (fromSchema && e.builtin) {
    return {
      key: e.key,
      path: e.path,
      type: fromSchema.type,
      allowed: fromSchema.allowed ?? e.builtin.allowed,
      min: e.builtin.min,
      max: e.builtin.max,
      default: fromSchema.default ?? e.builtin.default,
      writable: e.writable,
      defSource: "schema",
      description: e.description,
    };
  }
  const b = e.builtin!;
  return {
    key: e.key,
    path: e.path,
    type: b.type,
    allowed: b.allowed,
    min: b.min,
    max: b.max,
    default: b.default,
    writable: e.writable,
    defSource: "builtin",
    description: e.description,
  };
}

/** All resolved setting definitions (schema-aware). */
export function settingDefs(): SettingDef[] {
  return REGISTRY.map(resolveDef);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAtPath(obj: Record<string, unknown> | null, p: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of p) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Coerce a raw stored value to the setting's declared type (env values are strings). */
function coerceRead(def: SettingDef, raw: unknown): unknown {
  if (def.type === "integer" && typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

export interface ClaudeSettings {
  settings: SettingValue[];
  /** Resolved absolute file paths read (for transparency). */
  sources: { settings: string; local: string; claudeJson: string };
}

/**
 * Read the known Claude Code settings, resolving each value across the source
 * files in precedence order (settings.local.json > settings.json > ~/.claude.json)
 * and reporting which file supplied it. Unset keys fall back to the schema/builtin
 * default with source "default". Never throws on missing files.
 */
export function readClaudeSettings(): ClaudeSettings {
  const sources: { file: string; label: string; obj: Record<string, unknown> | null }[] = [
    { file: settingsLocalFile(), label: "settings.local.json", obj: readJson(settingsLocalFile()) },
    { file: settingsFile(), label: "settings.json", obj: readJson(settingsFile()) },
    { file: dotClaudeJson(), label: ".claude.json", obj: readJson(dotClaudeJson()) },
  ];

  const settings: SettingValue[] = settingDefs().map((def) => {
    let value: unknown = def.default;
    let source = "default";
    for (const s of sources) {
      const raw = getAtPath(s.obj, def.path);
      if (raw !== undefined) {
        value = coerceRead(def, raw);
        source = s.label;
        break;
      }
    }
    return {
      key: def.key,
      value,
      type: def.type,
      allowed: def.allowed,
      min: def.min,
      max: def.max,
      default: def.default,
      writable: def.writable,
      defSource: def.defSource,
      description: def.description,
      source,
    };
  });

  return {
    settings,
    sources: {
      settings: settingsFile(),
      local: settingsLocalFile(),
      claudeJson: dotClaudeJson(),
    },
  };
}

// Keys/surfaces the write endpoint must never touch, even if a future registry
// edit slips. Belt-and-suspenders on top of the writable allowlist.
const RISKY_KEYS = new Set(["permissions", "hooks", "mcpServers"]);

export interface WriteResult {
  ok: boolean;
  /** HTTP-ish status hint for the route. */
  status?: number;
  error?: string;
  /** The persisted value (post-coercion) on success. */
  value?: unknown;
}

/** Validate a candidate value against a definition; returns the value to store or an error. */
function validateValue(
  def: SettingDef,
  value: unknown,
): { ok: true; store: unknown } | { ok: false; error: string } {
  switch (def.type) {
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, error: `${def.key} expects a boolean` };
      return { ok: true, store: value };
    case "enum":
      if (typeof value !== "string" || !(def.allowed ?? []).includes(value)) {
        return { ok: false, error: `${def.key} must be one of: ${(def.allowed ?? []).join(", ")}` };
      }
      return { ok: true, store: value };
    case "string":
      if (typeof value !== "string") return { ok: false, error: `${def.key} expects a string` };
      return { ok: true, store: value };
    case "integer": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(n)) return { ok: false, error: `${def.key} expects an integer` };
      if (def.min !== undefined && n < def.min) return { ok: false, error: `${def.key} must be >= ${def.min}` };
      if (def.max !== undefined && n > def.max) return { ok: false, error: `${def.key} must be <= ${def.max}` };
      // env-pathed integers are stored as strings (env values are strings).
      const isEnv = def.path[0] === "env";
      return { ok: true, store: isEnv ? String(n) : n };
    }
  }
}

function setAtPath(obj: Record<string, unknown>, p: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < p.length - 1; i++) {
    const seg = p[i]!;
    if (cur[seg] == null || typeof cur[seg] !== "object") cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[p[p.length - 1]!] = value;
}

/**
 * Write one allowlisted setting to ~/.claude/settings.json. Atomic (temp file +
 * rename), preserving every unknown key. Refuses unknown / non-writable keys,
 * the risky surfaces (permissions/hooks/mcpServers), and rejects invalid values.
 */
export function writeClaudeSetting(key: unknown, value: unknown): WriteResult {
  if (typeof key !== "string" || !key) {
    return { ok: false, status: 400, error: "key required" };
  }
  if (RISKY_KEYS.has(key)) {
    return { ok: false, status: 403, error: `refusing to write protected key: ${key}` };
  }
  const def = settingDefs().find((d) => d.key === key);
  if (!def || !def.writable) {
    return { ok: false, status: 400, error: `unknown or non-writable setting: ${key}` };
  }
  const v = validateValue(def, value);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const file = settingsFile();
  const current = readJson(file) ?? {};
  setAtPath(current, def.path, v.store);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `.settings.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, status: 500, error: `failed to write settings: ${(err as Error).message}` };
  }
  return { ok: true, value: coerceRead(def, v.store) };
}
