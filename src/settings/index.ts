// US-020: read-only settings surface for the Settings view.
//
// The Settings view consolidates *informational* configuration: which Claude
// Code lifecycle hooks are wired (so observed sessions self-report), and the
// remote-access (TLS) posture. There is intentionally NO cost-ceiling/budget
// here — that was removed in US-004/US-014; the plan is token-based, not
// dollar-metered. Theme + usage/plan preferences are client-side.
import fs from "node:fs";
import path from "node:path";
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
