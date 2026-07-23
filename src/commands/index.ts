// US-020: slash-commands reader for the composer's `/` autocomplete. Custom
// commands are markdown files under the Claude Code command roots:
//
//   - user     ~/.claude/commands/**/*.md
//   - project  <cwd>/.claude/commands/**/*.md
//
// A file's command name is its path relative to the root, `.md` stripped,
// subdirectories joined with `:` (Claude Code's namespacing —
// `commands/frontend/component.md` → `/frontend:component`). Description comes
// from the frontmatter `description:` (same parser as skills), falling back to
// the first non-empty body line; `argument-hint:` is surfaced when present.
//
// Built-ins are a hardcoded, EMPIRICALLY VERIFIED headless-safe subset — the
// gateway can't enumerate the CLI's internal command list, and most built-ins
// are TUI-only (headless `claude -p "/x"` answers "/x isn't available in this
// environment"). Each entry below was probed against the installed CLI
// (claude 2.1.218, 2026-07-23). Excluded, with the probe verdict:
//   TUI-only  /help /status /export /memory /hooks /permissions /add-dir
//             /resume /vim /release-notes
//   removed   /todos /pr-comments ("Unknown command"), /agents (wizard stub)
//   works headless but conflicts with Conan  /model (would desync the
//             composer's locked model chip), /clear (meaningless against
//             Conan's one-process-per-thread sessions; empty output)

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { frontmatterField } from "../skills/index.js";

export type CommandSource = "user" | "project" | "built-in";

/** One slash command, as the composer's `/` menu renders it. */
export interface CommandEntry {
  /** Bare name without the leading slash — insert as `/name`. */
  name: string;
  /** Frontmatter/first-line description, or null (never fabricated). */
  description: string | null;
  source: CommandSource;
  /** Frontmatter `argument-hint:` (e.g. "[pr-number]") when present. */
  argumentHint?: string;
}

/** Recursion bound: `a/b/c.md` (depth 3) is deeper than any real layout. */
const MAX_DEPTH = 3;

/**
 * Built-ins verified to run under headless `claude -p` (see header). Probe
 * transcript summarized per entry; descriptions are ours (the CLI exposes
 * none headless).
 */
export const HEADLESS_BUILTINS: CommandEntry[] = [
  { name: "compact", description: "Compact the conversation to free context", source: "built-in" },
  { name: "context", description: "Show context-window usage by category", source: "built-in" },
  { name: "cost", description: "Show usage / cost for the current session", source: "built-in" },
  { name: "usage", description: "Show plan usage + rate-limit windows", source: "built-in" },
  { name: "mcp", description: "MCP server status / reconnect", source: "built-in", argumentHint: "[reconnect|enable|disable [server]]" },
  { name: "insights", description: "Generate a shareable usage-insights report", source: "built-in" },
  { name: "doctor", description: "Diagnose the Claude Code installation", source: "built-in" },
  { name: "init", description: "Analyze the project and generate a CLAUDE.md", source: "built-in" },
  { name: "review", description: "Review a pull request", source: "built-in", argumentHint: "[pr-number]" },
  { name: "security-review", description: "Security review of pending changes", source: "built-in" },
];

/** First non-empty body line (frontmatter block skipped), for description fallback. */
function firstBodyLine(text: string): string | null {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line.length > 0) return line.length > 120 ? line.slice(0, 119) + "…" : line;
  }
  return null;
}

/** Walk one command root, collecting `*.md` files as entries (depth-bounded). */
function readRoot(root: string, source: CommandSource): CommandEntry[] {
  const out: CommandEntry[] = [];
  const walk = (dir: string, prefix: string[], depth: number) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return; // root absent / unreadable → no commands
    }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, [...prefix, name], depth + 1);
        continue;
      }
      if (!stat.isFile() || !name.endsWith(".md")) continue;
      let text: string;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const entry: CommandEntry = {
        name: [...prefix, name.slice(0, -3)].join(":"),
        description: frontmatterField(text, "description") ?? firstBodyLine(text),
        source,
      };
      const hint = frontmatterField(text, "argument-hint");
      if (hint) entry.argumentHint = hint;
      out.push(entry);
    }
  };
  walk(root, [], 1);
  return out;
}

/**
 * Every slash command the composer should offer: project commands first (they
 * read most-specific), then user commands, then the verified headless-safe
 * built-ins. A custom command shadowing a built-in name wins (built-in
 * dropped); user/project entries sharing a name both survive — they are
 * distinct, separately-scoped commands, so the menu labels the source.
 */
export function readCommands(cwd: string | null): CommandEntry[] {
  const project = cwd ? readRoot(path.join(cwd, ".claude", "commands"), "project") : [];
  const user = readRoot(path.join(HOME, ".claude", "commands"), "user");
  const custom = new Set([...project, ...user].map((e) => e.name));
  const builtins = HEADLESS_BUILTINS.filter((b) => !custom.has(b.name));
  return [...project, ...user, ...builtins];
}
