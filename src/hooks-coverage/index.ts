// US-009: hooks-coverage — Conan's hook consumption vs Claude Code's FULL set.
//
// Claude Code fires far more lifecycle hook events than Conan currently
// ingests. This module answers two questions, per scope, for an operator:
//   1. What is the full known set of Claude Code hook events? (the source of
//      truth is the bundled canonical settings schema — its `hooks.properties`
//      keys, never a guessed list)
//   2. Which of those does Conan *consume* (it has an ingestion path — the nine
//      events in conan-hooks.example.json / settings.KNOWN_HOOK_EVENTS), and
//      which are actually *wired* in each settings file's `hooks` block
//      (user ~/.claude/settings.json + project .claude/settings.json)?
//
// Events Conan can't consume yet (SubagentStart, PermissionRequest, StopFailure,
// …) are flagged so the coverage gap is visible. Read-only; never throws —
// missing schema, missing settings files, or unparseable JSON all degrade to a
// safe shape. Paths resolve from CONAN_CLAUDE_DIR (the same override the other
// readers use) and an injectable projectDir, so tests can point at fixtures.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "../paths.js";
import { KNOWN_HOOK_EVENTS } from "../settings/index.js";
import { getActiveCwd } from "../cwd/index.js";

/** Hook scopes Conan inspects: the user-level and the active project's settings. */
export type HookScope = "user" | "project";

export interface HookEventCoverage {
  /** The hook event name (e.g. "PreToolUse"). */
  event: string;
  /** Schema description of when the event fires, when available. */
  description: string;
  /** Whether Conan has an ingestion path for this event (the nine it consumes). */
  consumedByConan: boolean;
  /** Whether a non-empty hook is configured for this event, per settings scope. */
  wired: Record<HookScope, boolean>;
}

export interface HooksCoveragePayload {
  events: HookEventCoverage[];
  /** The events Conan consumes (subset of the full set). */
  consumed: string[];
  summary: {
    /** Size of the full known hook-event set. */
    total: number;
    /** How many of the full set Conan consumes. */
    consumed: number;
    /** Full-set events Conan does NOT consume yet. */
    unconsumed: number;
    /** How many events are wired in each scope's settings.json. */
    wiredUser: number;
    wiredProject: number;
  };
  /** Where Conan read the `hooks` block from, per scope (for transparency). */
  scopes: Record<HookScope, string[]>;
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}

// Fallback full hook-event set, used only when the bundled schema can't be read.
// Mirrors the schema's hooks.properties at build time so the endpoint still
// returns a sensible superset of Conan's consumed events when the schema is gone.
const FALLBACK_EVENTS: { event: string; description: string }[] = [
  { event: "PreToolUse", description: "Hooks that run before tool calls" },
  { event: "PostToolUse", description: "Hooks that run after tool completion" },
  { event: "PostToolUseFailure", description: "Hooks that run after a tool fails" },
  { event: "PermissionRequest", description: "Hooks that run when a permission dialog appears" },
  { event: "Notification", description: "Hooks that trigger on notifications" },
  { event: "UserPromptSubmit", description: "Hooks that run when a user submits a prompt" },
  { event: "Stop", description: "Hooks that run when agents finish responding" },
  { event: "StopFailure", description: "Hooks that run when a turn ends due to an API error" },
  { event: "SubagentStart", description: "Hooks that run when a subagent is spawned" },
  { event: "SubagentStop", description: "Hooks that run when subagents finish responding" },
  { event: "PreCompact", description: "Hooks that run before the context is compacted" },
  { event: "PostCompact", description: "Hooks that run after the context is compacted" },
  { event: "SessionStart", description: "Hooks that run when a new session starts" },
  { event: "SessionEnd", description: "Hooks that run when a session ends" },
];

let fullSetCache: { event: string; description: string }[] | undefined;
/**
 * The full known Claude Code hook-event set, sourced from the bundled canonical
 * settings schema's `hooks.properties` keys (json.schemastore.org snapshot),
 * never guessed. Falls back to FALLBACK_EVENTS when the schema is unreadable.
 */
function fullHookSet(): { event: string; description: string }[] {
  if (fullSetCache !== undefined) return fullSetCache;
  try {
    const file = fileURLToPath(
      new URL("../settings/claude-code-settings.schema.json", import.meta.url),
    );
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
      properties?: { hooks?: { properties?: Record<string, { description?: string }> } };
    };
    const props = json.properties?.hooks?.properties;
    if (props && Object.keys(props).length > 0) {
      fullSetCache = Object.entries(props).map(([event, def]) => ({
        event,
        description: def?.description ?? "",
      }));
      return fullSetCache;
    }
  } catch {
    /* fall through to the bundled fallback */
  }
  fullSetCache = FALLBACK_EVENTS;
  return fullSetCache;
}

/** Which known events a single settings.json wires (non-empty hook array). */
function wiredEventsIn(file: string): Set<string> {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    const hooks = json.hooks ?? {};
    const wired = new Set<string>();
    for (const [event, val] of Object.entries(hooks)) {
      if (Array.isArray(val) && val.length > 0) wired.add(event);
    }
    return wired;
  } catch {
    return new Set();
  }
}

/** The settings files Conan reads for a scope (settings.json + settings.local.json). */
function scopeFiles(scope: HookScope, projectDir: string): string[] {
  const dir = scope === "user" ? claudeDir() : path.join(projectDir, ".claude");
  return [path.join(dir, "settings.json"), path.join(dir, "settings.local.json")];
}

/**
 * Report Conan's hook coverage: the full known Claude Code hook-event set, each
 * marked consumed-by-Conan and wired-or-not per scope (user + project). The
 * project scope defaults to the active cwd (US-003) but is injectable for tests.
 * Never throws — absent schema/settings degrade to a safe shape.
 */
export function readHooksCoverage(
  opts: { projectDir?: string } = {},
): HooksCoveragePayload {
  const projectDir = opts.projectDir ?? getActiveCwd();
  const consumed = new Set<string>(KNOWN_HOOK_EVENTS);

  const scopeFileMap: Record<HookScope, string[]> = {
    user: scopeFiles("user", projectDir),
    project: scopeFiles("project", projectDir),
  };
  const wiredByScope: Record<HookScope, Set<string>> = {
    user: new Set(),
    project: new Set(),
  };
  for (const scope of ["user", "project"] as HookScope[]) {
    for (const file of scopeFileMap[scope]) {
      for (const ev of wiredEventsIn(file)) wiredByScope[scope].add(ev);
    }
  }

  const full = fullHookSet();
  const events: HookEventCoverage[] = full.map(({ event, description }) => ({
    event,
    description,
    consumedByConan: consumed.has(event),
    wired: {
      user: wiredByScope.user.has(event),
      project: wiredByScope.project.has(event),
    },
  }));

  const consumedCount = events.filter((e) => e.consumedByConan).length;
  return {
    events,
    consumed: [...consumed],
    summary: {
      total: events.length,
      consumed: consumedCount,
      unconsumed: events.length - consumedCount,
      wiredUser: wiredByScope.user.size,
      wiredProject: wiredByScope.project.size,
    },
    scopes: scopeFileMap,
  };
}
