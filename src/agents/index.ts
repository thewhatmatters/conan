// US-012: custom-agents catalog — surface the agent definitions the user has on
// disk so the Agents page (US-027) can list them. Read-only.
//
// Claude Code agents live in two scopes, and in two on-disk layouts:
//   user:    ~/.claude/agents/
//   project: <active cwd>/.claude/agents/
// Within a scope, an agent is either
//   - a flat markdown file:  <root>/<name>.md        (standard subagent format)
//   - a directory with a manifest:  <root>/<name>/SOUL.md (or <name>.md inside)
// Each carries YAML frontmatter with at least `name`/`role` and `description`,
// and optionally `tools` (a YAML list or a comma-separated string).
//
// This module never throws: missing dirs, unreadable files, or absent
// frontmatter all degrade to an empty list / null fields. The ~/.claude dir is
// overridable for tests via CONAN_CLAUDE_DIR; the project root defaults to the
// active cwd but is overridable for tests.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { getActiveCwd } from "../cwd/index.js";

/** One custom agent definition parsed from its frontmatter. */
export interface CustomAgent {
  /** Display name — frontmatter `name`, else the file/dir basename. */
  name: string;
  /** Frontmatter `description`, else `role` if no description present. */
  description: string | null;
  /** Frontmatter `role` (free-form), when present. */
  role: string | null;
  /** "user" | "project". */
  scope: "user" | "project";
  /** Tools the agent is granted (frontmatter `tools`); null when unspecified. */
  tools: string[] | null;
  /** Absolute path of the manifest file the agent was parsed from. */
  source: string;
}

export interface AgentsCatalog {
  agents: CustomAgent[];
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}

/**
 * Extract the YAML frontmatter block (between the first pair of `---` fences)
 * as a flat key→raw-string map. Good enough for the simple `key: value` and
 * `tools: [a, b]` / `tools: a, b` shapes Claude Code agents use; never throws.
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
    // Strip surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key.toLowerCase()] = val;
  }
  return out;
}

/** Parse a `tools` frontmatter value (YAML inline list or comma list) → names. */
function parseTools(raw: string | undefined): string[] | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const tools = s
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return tools.length ? tools : null;
}

/** Read + parse one manifest file into a CustomAgent, or null if unreadable. */
function parseAgentFile(file: string, fallbackName: string, scope: "user" | "project"): CustomAgent | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  const role = fm.role ?? null;
  return {
    name: fm.name?.trim() || fallbackName,
    description: fm.description?.trim() || role,
    role,
    scope,
    tools: parseTools(fm.tools),
    source: file,
  };
}

/** Locate the manifest inside an agent directory (SOUL.md, else <dir>/<name>.md). */
function manifestInDir(dir: string, name: string): string | null {
  const candidates = [
    path.join(dir, "SOUL.md"),
    path.join(dir, `${name}.md`),
    path.join(dir, "AGENT.md"),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not present */
    }
  }
  return null;
}

/** Scan one agents root for agent definitions (flat files + dir manifests). */
function scanAgentsRoot(root: string, scope: "user" | "project"): CustomAgent[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // root absent / unreadable
  }
  const agents: CustomAgent[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const name = e.name.replace(/\.md$/i, "");
      const a = parseAgentFile(path.join(root, e.name), name, scope);
      if (a) agents.push(a);
    } else if (e.isDirectory()) {
      const manifest = manifestInDir(path.join(root, e.name), e.name);
      if (manifest) {
        const a = parseAgentFile(manifest, e.name, scope);
        if (a) agents.push(a);
      }
    }
  }
  return agents;
}

export interface ReadAgentsOptions {
  /** Override ~/.claude (tests). */
  claudeDir?: string;
  /** Active project root scanned for .claude/agents (defaults to active cwd). */
  projectDir?: string;
}

/**
 * Read the custom-agents catalog across user + project scopes. Missing dirs,
 * unreadable files, and absent frontmatter all degrade gracefully — never throws.
 */
export function readAgents(opts: ReadAgentsOptions = {}): AgentsCatalog {
  const dir = opts.claudeDir ?? claudeDir();
  const projectDir = opts.projectDir ?? getActiveCwd();

  const agents = [
    ...scanAgentsRoot(path.join(dir, "agents"), "user"),
    ...scanAgentsRoot(path.join(projectDir, ".claude", "agents"), "project"),
  ];

  // Stable order: project scope after user, then by name.
  agents.sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
  );
  return { agents };
}
