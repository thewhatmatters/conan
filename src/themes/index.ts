// User themes (US-022) — reads + validates ~/.conan/themes.json so a user can
// add their own palettes beyond the bundled built-ins (ui/src/lib/themes.ts).
//
// The gateway exposes the validated list at GET /api/claude/themes; the UI's
// useThemes hook merges them over the built-ins by id (a user theme may override
// a built-in or add a new one). User themes may be PARTIAL — the UI merges each
// over the built-in default for its `type`, so an omitted token still resolves.
//
// SECURITY: a theme value is written verbatim into a CSS custom property on
// <html> (style.setProperty(`--${key}`, value)). So validation is a strict
// whitelist on BOTH sides: the key must be a KNOWN canonical token (no arbitrary
// custom properties), and the value must fully match an allowed color literal
// (hex / rgb(a) / hsl(a)) — anchored patterns that reject url(), expression(),
// semicolons, braces, and any other raw-CSS injection. Anything that doesn't
// fully match is rejected; a bad key/value rejects the whole theme entry (it is
// skipped with a logged reason, never partially trusted).

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

/** A user theme as returned to the UI (mirrors the UI Theme shape). */
export interface UserTheme {
  id: string;
  name: string;
  type: "light" | "dark";
  /** Partial token map — every present key is a KNOWN token with a valid color. */
  tokens: Record<string, string>;
}

/**
 * Canonical themeable token keys — MUST mirror TOKEN_KEYS in ui/src/lib/themes.ts
 * (the ~30 color custom properties; `--radius` is intentionally not themeable).
 * A user theme may only set keys in this set; the leading `--` is added on apply.
 */
export const KNOWN_TOKEN_KEYS: readonly string[] = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "border",
  "muted",
  "muted-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "popover",
  "popover-foreground",
  "destructive",
  "destructive-foreground",
  "input",
  "ring",
  "term-bg",
  "term-fg",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "heat-0",
  "heat-1",
  "heat-2",
  "heat-3",
  "heat-4",
];

const KNOWN_KEY_SET = new Set(KNOWN_TOKEN_KEYS);

// --- Color literal whitelist --------------------------------------------------
// Anchored (^…$), so a value that smuggles in `url(...)`, `expression(...)`, a
// trailing `; …`, comment markers, or braces cannot match — only a clean color
// literal passes. We accept the three forms a theme realistically needs.

/** #rgb | #rgba | #rrggbb | #rrggbbaa */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** rgb(...)/rgba(...) — comma or space separated, optional %/alpha, modern `/` alpha. */
const RGB_RE =
  /^rgba?\(\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/;
/** hsl(...)/hsla(...) — first arg may carry `deg`, rest are %, optional alpha. */
const HSL_RE =
  /^hsla?\(\s*[\d.]+(?:deg)?\s*[,\s]\s*[\d.]+%?\s*[,\s]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/;

/** True only for a clean hex / rgb(a) / hsl(a) color literal. */
export function isValidColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return HEX_RE.test(v) || RGB_RE.test(v) || HSL_RE.test(v);
}

/** True for a canonical token key (one of KNOWN_TOKEN_KEYS). */
export function isKnownTokenKey(key: string): boolean {
  return KNOWN_KEY_SET.has(key);
}

/**
 * Validate one raw theme entry. Pure — no fs. Returns the sanitized UserTheme on
 * success, or `{ error }` with a human reason on rejection. Rejects the WHOLE
 * entry on any unknown token key or non-color value (no partial trust); a value
 * is written into a CSS var, so an injection in one token taints the theme.
 */
export function validateUserTheme(
  raw: unknown,
): { theme: UserTheme } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: "not an object" };
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== "string" || o.id.trim() === "")
    return { error: "missing/invalid id" };
  if (typeof o.name !== "string" || o.name.trim() === "")
    return { error: `theme "${o.id}": missing/invalid name` };
  if (o.type !== "light" && o.type !== "dark")
    return { error: `theme "${o.id}": type must be "light" or "dark"` };
  if (typeof o.tokens !== "object" || o.tokens === null || Array.isArray(o.tokens))
    return { error: `theme "${o.id}": tokens must be an object` };

  const rawTokens = o.tokens as Record<string, unknown>;
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawTokens)) {
    if (!isKnownTokenKey(key))
      return { error: `theme "${o.id}": unknown token key "${key}"` };
    if (!isValidColor(value))
      return {
        error: `theme "${o.id}": token "${key}" is not a valid color (${JSON.stringify(value)})`,
      };
    tokens[key] = (value as string).trim();
  }

  return {
    theme: { id: o.id.trim(), name: o.name.trim(), type: o.type, tokens },
  };
}

/**
 * Validate a parsed themes payload (an array of raw theme entries, or `{themes:[…]}`).
 * Pure — no fs. Invalid entries are skipped with a console.warn reason; returns
 * only the valid ones. A non-array/non-{themes} shape yields []. Duplicate ids
 * are de-duped (last wins) so the UI merge stays deterministic.
 */
export function validateUserThemes(parsed: unknown): UserTheme[] {
  let arr: unknown[];
  if (Array.isArray(parsed)) arr = parsed;
  else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).themes)
  )
    arr = (parsed as { themes: unknown[] }).themes;
  else {
    if (parsed != null)
      console.warn("[themes] themes.json is not an array or {themes:[…]} — ignoring");
    return [];
  }

  const byId = new Map<string, UserTheme>();
  for (const entry of arr) {
    const result = validateUserTheme(entry);
    if ("error" in result) {
      console.warn(`[themes] skipping theme: ${result.error}`);
      continue;
    }
    byId.set(result.theme.id, result.theme);
  }
  return Array.from(byId.values());
}

/**
 * The base directory user themes live in. Defaults to ~/.conan; CONAN_DATA_DIR-
 * aware (the Tauri app sets CONAN_DATA_DIR to its app-support dir — see the
 * conan-live-data-pipeline data-dir gotcha), and CONAN_THEMES_DIR overrides
 * either explicitly (also the test seam).
 */
export function themesBaseDir(): string {
  return (
    process.env.CONAN_THEMES_DIR ??
    process.env.CONAN_DATA_DIR ??
    path.join(HOME, ".conan")
  );
}

/**
 * Read + validate user themes from disk. Reads `<base>/themes.json` and every
 * `<base>/themes/*.json`, validates each, and returns the merged valid list
 * (later sources win by id). A missing file or directory yields []; a malformed
 * JSON file is skipped with a logged reason and never crashes. Never throws.
 *
 * @param baseDir override the themes directory (defaults to themesBaseDir()).
 */
export function readUserThemes(baseDir: string = themesBaseDir()): UserTheme[] {
  const sources: unknown[] = [];

  const single = path.join(baseDir, "themes.json");
  readJsonInto(single, sources);

  const dir = path.join(baseDir, "themes");
  try {
    if (fs.statSync(dir).isDirectory()) {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name.endsWith(".json")) readJsonInto(path.join(dir, name), sources);
      }
    }
  } catch {
    // No themes/ dir — fine.
  }

  // Each source is an array or {themes:[…]} or a single theme object; flatten +
  // validate together so ids de-dupe across files (last file wins).
  const byId = new Map<string, UserTheme>();
  for (const src of sources) {
    const list = Array.isArray(src) || isThemesWrapper(src) ? validateUserThemes(src) : validateUserThemes([src]);
    for (const t of list) byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

function isThemesWrapper(x: unknown): boolean {
  return (
    !!x &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Array.isArray((x as Record<string, unknown>).themes)
  );
}

/** Read + JSON.parse a file into `out`; skip (with a logged reason) on any error. */
function readJsonInto(file: string, out: unknown[]): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // Absent file — not an error.
  }
  try {
    out.push(JSON.parse(text));
  } catch (err) {
    console.warn(
      `[themes] skipping ${file}: malformed JSON (${(err as Error).message})`,
    );
  }
}
