// Installed-agents reader for the Agents HUD tab. Claude Code subagents are
// flat `.md` files (NOT `<dir>/SKILL.md` like skills) whose YAML frontmatter
// carries `name`, `description`, and optionally `tools` + `model`. Same
// honest-by-construction contract as the skills reader: a missing frontmatter
// field is null — never fabricated.
//
// Sources (dedup by name, first-seen wins — same precedence as readSkills):
//   - User    ~/.claude/agents/<agent>.md
//   - Project <cwd>/.claude/agents/<agent>.md
//   - Plugin  <installPath>/agents/<agent>.md  (plugins ship `.md.tmpl`
//             templates alongside — the `.md` suffix filter skips those)

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { frontmatterField, homeRelative, pluginRoots } from "../skills/index.js";

/** Where an agent came from. `Plugin` carries the plugin key in `plugin`. */
export type AgentSource = "User" | "Project" | "Plugin";

/** One installed agent, as the Agents HUD tab renders it. */
export interface AgentEntry {
  name: string;
  /** Frontmatter description, or null when none is readable (never fabricated). */
  description: string | null;
  source: AgentSource;
  /** Plugin key (e.g. "vercel@claude-plugins-official") when source==Plugin. */
  plugin?: string;
  /** The agent's on-disk `.md` file, home-relative (`~/…`). */
  path?: string;
  /** Raw frontmatter `tools:` value (comma-separated list), or null. */
  tools?: string | null;
  /** Raw frontmatter `model:` value, or null. */
  model?: string | null;
}

/** Read + parse one agent `.md` file into an entry. */
function readAgentFile(root: string, fileName: string, source: AgentSource, plugin?: string): AgentEntry | null {
  const file = path.join(root, fileName);
  let text: string;
  try {
    if (!fs.statSync(file).isFile()) return null; // a directory named *.md
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // unreadable → caller skips it
  }
  const name = frontmatterField(text, "name");
  const description = frontmatterField(text, "description");
  // A real subagent declares frontmatter (Claude Code requires name +
  // description). A plain .md with neither — a stray CLAUDE.md/HANDOFF.md
  // dropped in the agents dir — is not an agent.
  if (name == null && description == null) return null;
  const entry: AgentEntry = {
    name: name ?? fileName.replace(/\.md$/, ""),
    description,
    source,
    path: homeRelative(file),
    tools: frontmatterField(text, "tools"),
    model: frontmatterField(text, "model"),
  };
  if (plugin) entry.plugin = plugin;
  return entry;
}

/** Every agent under one root dir (each immediate `*.md` file). */
export function readAgentsRoot(root: string, source: AgentSource, plugin?: string): AgentEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return []; // root absent → no agents
  }
  const out: AgentEntry[] = [];
  for (const fileName of entries.sort()) {
    if (!fileName.endsWith(".md")) continue; // skips .md.tmpl, dotfiles, subdirs
    const e = readAgentFile(root, fileName, source, plugin);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Read every installed agent (user + project + plugin) with its frontmatter
 * description. Deduped by name across sources (User > Project > Plugin
 * precedence — first-seen wins, mirroring readSkills).
 */
export function readAgents(cwd: string | null): AgentEntry[] {
  const collected: AgentEntry[] = [];
  collected.push(...readAgentsRoot(path.join(HOME, ".claude", "agents"), "User"));
  if (cwd) collected.push(...readAgentsRoot(path.join(cwd, ".claude", "agents"), "Project"));
  for (const { plugin, installPath } of pluginRoots()) {
    collected.push(...readAgentsRoot(path.join(installPath, "agents"), "Plugin", plugin));
  }
  const seen = new Set<string>();
  const out: AgentEntry[] = [];
  for (const e of collected) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}
