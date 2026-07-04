// US-005: installed-skills reader for the Skills HUD tab (US-006). Descriptions
// are NOT in `/context` (it carries only skill names + sizes) — they live in each
// skill's SKILL.md YAML frontmatter. This walks the same skill roots as
// `skillTokens` (src/widgets/index.ts) but, instead of summing bytes, parses each
// SKILL.md's frontmatter into { name, description, source } so the UI can render a
// VS Code-extensions-style list.
//
// Sources:
//   - User    ~/.claude/skills/<skill>/SKILL.md
//   - Project <cwd>/.claude/skills/<skill>/SKILL.md
//   - Plugin  <installPath>/skills/<skill>/SKILL.md  (per ~/.claude/plugins/
//             installed_plugins.json; the plugin key is carried in `plugin`)
//   - Built-in harness slash-commands that have no on-disk SKILL.md — listed
//             name-only (the gateway can't enumerate them, so the route passes
//             none; the path exists + is tested so a future enumeration drops in)
//
// Honest by construction: a skill whose SKILL.md is missing or lacks a frontmatter
// `description:` is listed name-only with `description: null` — never fabricated.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

/** Where a skill came from. `Plugin` carries the plugin key in `plugin`. */
export type SkillSource = "User" | "Project" | "Plugin" | "Built-in";

/** One installed skill, as the Skills HUD tab renders it. */
export interface SkillEntry {
  name: string;
  /** Frontmatter description, or null when none is readable (never fabricated). */
  description: string | null;
  source: SkillSource;
  /** Plugin key (e.g. "example-skills@anthropic-agent-skills") when source==Plugin. */
  plugin?: string;
  /**
   * The skill's on-disk directory, home-relative (`~/…`) — this is what the HUD
   * shows in place of a source badge. Absent for Built-in harness skills, which
   * have no on-disk SKILL.md.
   */
  path?: string;
  /**
   * Epoch ms of the most recent observed firing across recent transcripts
   * (US-002 v4.5). Null when this skill has never been seen fire in the bounded
   * scan window — never fabricated. Populated by the GET /api/claude/skills
   * route, not by readSkills (which stays a pure SKILL.md reader).
   */
  lastFiredAt?: number | null;
}

/** Rewrite an absolute path to a `~/…` home-relative form for display. */
function homeRelative(abs: string): string {
  if (abs === HOME) return "~";
  return abs.startsWith(HOME + path.sep) ? "~" + abs.slice(HOME.length) : abs;
}

/**
 * Extract the `description:` value from a SKILL.md's YAML frontmatter, or null.
 * Pure + tested: parses only the leading `---`…`---` block, reads `key: value`
 * lines plus YAML block scalars (`>-`/`|`-style — descriptions with `: ` on
 * continuation lines must be written this way), and strips a matched
 * surrounding quote. Returns null when there's no frontmatter or no
 * `description` key — so callers never invent one.
 */
export function frontmatterDescription(text: string): string | null {
  return frontmatterField(text, "description");
}

/** Read one scalar field from the leading frontmatter block (null if absent). */
export function frontmatterField(text: string, key: string): string | null {
  // Frontmatter must be the very first thing in the file: `---` then lines then `---`.
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m || m[1] == null) return null;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv) continue;
    const [, field, rawValue] = kv;
    if (field !== key) continue;
    let v = (rawValue ?? "").trim();
    // Block scalar header (`>-`, `|`, `>+2`, …): the value is the indented
    // lines below, not the sigil itself — never return the bare header.
    const block = /^([|>])(?:[+-]?\d*|\d*[+-]?)$/.exec(v);
    if (block) return blockScalarValue(lines, i + 1, block[1] === ">");
    if (v.length === 0) return null;
    // Strip one matched surrounding quote pair.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.length > 0 ? v : null;
  }
  return null;
}

/**
 * Collect a block scalar's body: the run of blank-or-indented lines following
 * its header, ending at the first dedent back to column 0 (the next key).
 * Folded (`>`) joins lines with spaces; literal (`|`) keeps newlines. Chomping
 * indicators only govern trailing newlines, which a one-line HUD card never
 * shows — trailing blanks are just trimmed. A header with no body returns null.
 */
function blockScalarValue(lines: string[], start: number, folded: boolean): string | null {
  const body: string[] = [];
  let indent: number | null = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      body.push("");
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent === 0) break; // dedent → next frontmatter key
    if (indent == null) indent = lineIndent; // first line fixes the block indent
    body.push(line.slice(Math.min(indent, lineIndent)));
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  if (body.length === 0) return null;
  const v = folded
    ? body.map((l) => l.trim()).join(" ").replace(/\s+/g, " ").trim()
    : body.join("\n");
  return v.length > 0 ? v : null;
}

/** Read + parse a single skill dir's SKILL.md into an entry (name + description). */
function readSkillDir(root: string, dirName: string, source: SkillSource, plugin?: string): SkillEntry | null {
  const skillMd = path.join(root, dirName, "SKILL.md");
  let text: string;
  try {
    if (!fs.statSync(skillMd).isFile()) return null;
    text = fs.readFileSync(skillMd, "utf8");
  } catch {
    return null; // not a skill dir (no readable SKILL.md) → caller skips it
  }
  const name = frontmatterField(text, "name") ?? dirName;
  const entry: SkillEntry = {
    name,
    description: frontmatterDescription(text),
    source,
    path: homeRelative(path.join(root, dirName)),
  };
  if (plugin) entry.plugin = plugin;
  return entry;
}

/** Every skill under one root dir (each immediate subdir holding a SKILL.md). */
function readRoot(root: string, source: SkillSource, plugin?: string): SkillEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return []; // root absent → no skills
  }
  const out: SkillEntry[] = [];
  for (const dirName of entries.sort()) {
    const e = readSkillDir(root, dirName, source, plugin);
    if (e) out.push(e);
  }
  return out;
}

/** Installed plugins from ~/.claude/plugins/installed_plugins.json (key→installPaths). */
function pluginRoots(): { plugin: string; skillsDir: string }[] {
  const out: { plugin: string; skillsDir: string }[] = [];
  let json: unknown;
  try {
    json = JSON.parse(
      fs.readFileSync(path.join(HOME, ".claude", "plugins", "installed_plugins.json"), "utf8"),
    );
  } catch {
    return out; // no plugins manifest → none
  }
  const plugins = (json as Record<string, unknown>)?.plugins;
  if (!plugins || typeof plugins !== "object") return out;
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue;
    for (const inst of installs) {
      const installPath = (inst as Record<string, unknown>)?.installPath;
      if (typeof installPath === "string" && installPath) {
        out.push({ plugin: key, skillsDir: path.join(installPath, "skills") });
      }
    }
  }
  return out;
}

/**
 * Read every installed skill (user + project + plugin) with its frontmatter
 * description. `builtins` (optional) are harness slash-commands with no on-disk
 * SKILL.md — emitted name-only (description null, source Built-in); the route
 * passes none since the gateway can't enumerate the harness's command list.
 * Deduped by name across sources (User > Project > Plugin > Built-in precedence).
 */
export function readSkills(cwd: string | null, builtins: string[] = []): SkillEntry[] {
  const collected: SkillEntry[] = [];
  collected.push(...readRoot(path.join(HOME, ".claude", "skills"), "User"));
  if (cwd) collected.push(...readRoot(path.join(cwd, ".claude", "skills"), "Project"));
  for (const { plugin, skillsDir } of pluginRoots()) {
    collected.push(...readRoot(skillsDir, "Plugin", plugin));
  }
  for (const name of builtins) {
    collected.push({ name, description: null, source: "Built-in" });
  }
  // First-seen wins, so the source-order above is the precedence.
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const e of collected) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}
