// US-010: data source for the "Skills" hero widget.
//
// Two figures power the widget:
//   - available: how many skills exist on this machine (user + project scopes),
//     counted by scanning the skill directories for SKILL.md files.
//   - loaded(sessionId): how many slash commands / skills a given session has
//     loaded, derived from that session's `system/init` event (the stream-json
//     parser stores `slash_commands` in the payload — see src/session/parser.ts).
//
// Pure-ish read helpers (fs + db reads), no broadcasting, so the gateway route
// is a thin wrapper.

import fs from "node:fs";
import path from "node:path";
import { HOME, PACKAGE_ROOT } from "../paths.js";
import { getDb } from "../db/index.js";
import { getActiveCwd } from "../cwd/index.js";

/** Skill directories we scan, in scope order (user, then project). */
function skillRoots(): string[] {
  return [
    path.join(HOME, ".claude", "skills"),
    path.join(PACKAGE_ROOT, ".claude", "skills"),
  ];
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}

/** A directory is a skill if it (or a child) contains a SKILL.md. */
function isSkillDir(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return true;
  // Plugin-namespaced skills nest one level: <root>/<plugin>/<skill>/SKILL.md.
  try {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory()) {
        if (fs.existsSync(path.join(dir, child.name, "SKILL.md"))) return true;
      }
    }
  } catch {
    /* unreadable dir — not a skill */
  }
  return false;
}

/** Count distinct skills available across the user + project scopes. */
export function countAvailableSkills(): number {
  const seen = new Set<string>();
  for (const root of skillRoots()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist in this environment
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (isSkillDir(dir)) seen.add(e.name);
    }
  }
  return seen.size;
}

/**
 * How many slash commands / skills the given session loaded, read from the
 * latest `system/init` event's payload. Returns null when there's no such
 * event (e.g. a hook-only session that never ran headless stream-json).
 */
export function countLoadedForSession(sessionId: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT payload FROM event
         WHERE session_id = ? AND stream_type = 'system/init'
         ORDER BY ts DESC LIMIT 1`,
    )
    .get(sessionId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const cmds = payload.slash_commands;
    if (Array.isArray(cmds)) return cmds.length;
  } catch {
    /* malformed payload */
  }
  return null;
}

/** The widget's shape: total available + loaded for the active session. */
export function readSkills(sessionId?: string): {
  available: number;
  loaded: number | null;
} {
  return {
    available: countAvailableSkills(),
    loaded: sessionId ? countLoadedForSession(sessionId) : null,
  };
}

// --- US-016: the browsable skills catalog ----------------------------------
//
// Beyond the widget's two counts, the Skills page (US-028) needs the actual
// list: every skill across the user (~/.claude/skills) and active-project
// (<cwd>/.claude/skills) scopes, each with its name + description (from SKILL.md
// frontmatter) and whether a given session has it loaded.

/** One skill in the catalog. */
export interface SkillInfo {
  /** Frontmatter `name`, else the skill's directory basename. */
  name: string;
  /** Frontmatter `description`, else null. */
  description: string | null;
  /** "user" (global ~/.claude/skills) | "project" (<cwd>/.claude/skills). */
  scope: "user" | "project";
  /**
   * Whether the queried session has this skill loaded (its name appears in the
   * session's system/init slash_commands). null when no session was given or it
   * has no init event to read from.
   */
  loaded: boolean | null;
  /** Absolute path of the SKILL.md the skill was parsed from. */
  source: string;
}

export interface SkillsCatalog {
  skills: SkillInfo[];
}

/**
 * Extract the YAML frontmatter block (between the first pair of `---` fences)
 * as a flat key→raw-string map. SKILL.md uses simple single-line `key: value`
 * pairs (name + a long single-line description). Never throws.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m || m[1] == null) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!key || key.startsWith("#")) continue;
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key.toLowerCase()] = val;
  }
  return out;
}

/** Locate the SKILL.md for one entry: <dir>/SKILL.md, else <dir>/<name>/SKILL.md. */
function skillManifest(root: string, name: string): string | null {
  const flat = path.join(root, name, "SKILL.md");
  try {
    if (fs.statSync(flat).isFile()) return flat;
  } catch {
    /* not present */
  }
  return null;
}

/** Scan one skills root into SkillInfo entries (frontmatter name + description). */
function scanSkillsRoot(root: string, scope: "user" | "project"): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // root absent / unreadable
  }
  const skills: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = skillManifest(root, e.name);
    if (!manifest) continue;
    let fm: Record<string, string> = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(manifest, "utf8"));
    } catch {
      /* unreadable — keep basename, null description */
    }
    skills.push({
      name: fm.name?.trim() || e.name,
      description: fm.description?.trim() || null,
      scope,
      loaded: null,
      source: manifest,
    });
  }
  return skills;
}

/**
 * The set of slash-command / skill names the given session loaded, from its
 * latest system/init event. null when there's no such event.
 */
function loadedNamesForSession(sessionId: string): Set<string> | null {
  const row = getDb()
    .prepare(
      `SELECT payload FROM event
         WHERE session_id = ? AND stream_type = 'system/init'
         ORDER BY ts DESC LIMIT 1`,
    )
    .get(sessionId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const cmds = payload.slash_commands;
    if (!Array.isArray(cmds)) return null;
    // slash_commands may be namespaced (e.g. "plugin:skill"); index both the
    // full token and its last segment so a bare skill name still matches.
    const set = new Set<string>();
    for (const c of cmds) {
      if (typeof c !== "string") continue;
      set.add(c);
      const seg = c.split(":").pop();
      if (seg) set.add(seg);
    }
    return set;
  } catch {
    return null;
  }
}

export interface ListSkillsOptions {
  /** Override ~/.claude (tests). */
  claudeDir?: string;
  /** Active project root scanned for .claude/skills (defaults to active cwd). */
  projectDir?: string;
  /** Mark skills loaded from this session's system/init slash_commands. */
  sessionId?: string;
}

/**
 * The browsable skills catalog across user + project scopes. Missing dirs,
 * unreadable files, and absent frontmatter all degrade gracefully — never throws.
 */
export function listSkills(opts: ListSkillsOptions = {}): SkillsCatalog {
  const dir = opts.claudeDir ?? claudeDir();
  const projectDir = opts.projectDir ?? getActiveCwd();

  const skills = [
    ...scanSkillsRoot(path.join(dir, "skills"), "user"),
    ...scanSkillsRoot(path.join(projectDir, ".claude", "skills"), "project"),
  ];

  // Annotate `loaded` per skill when a session was given and has init data.
  const loaded = opts.sessionId ? loadedNamesForSession(opts.sessionId) : null;
  if (loaded) {
    for (const s of skills) s.loaded = loaded.has(s.name);
  }

  // Stable order: user scope before project, then by name.
  const rank = (s: SkillInfo) => (s.scope === "user" ? 0 : 1);
  skills.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { skills };
}
