// US-002: multi-project global hook installer.
//
// Today's hooks live in THIS repo's .claude/settings.json, so only `claude`
// runs inside ~/Development/conan self-report to the dashboard. To observe
// sessions across every repo on the machine we install the same forwarder into
// the *user-level* ~/.claude/settings.json — which applies to every Claude Code
// run regardless of cwd.
//
// Two things differ from the project hook:
//   1. The command must use an ABSOLUTE path to send-event.mjs. The project
//      hook can say `node scripts/hooks/send-event.mjs` because claude runs with
//      cwd=repo-root there; a global hook fires from arbitrary cwds, so a
//      relative path would not resolve.
//   2. The merge must be NON-DESTRUCTIVE and IDEMPOTENT: it preserves any
//      pre-existing user hooks/settings (unknown keys included) and never
//      appends a duplicate Conan group on re-run.
//
// The pure helpers (mergeGlobalHooks / removeGlobalHooks / conanHookCommand)
// are exported for the test; installGlobalHooks/uninstallGlobalHooks do the IO.
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT, HOME } from "../paths.js";

/** The Claude Code lifecycle events Conan forwards (mirrors the project hook). */
export const CONAN_HOOK_EVENTS = [
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

/** Events that take a tool matcher in Claude Code's hook schema. */
const MATCHER_EVENTS = new Set<string>(["PreToolUse", "PostToolUse"]);

/** Absolute path to the forwarder the hook command invokes. */
export const SEND_EVENT_SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "hooks",
  "send-event.mjs",
);

/**
 * The hook command for the GLOBAL install — an absolute `node <abs path>`, so
 * it resolves no matter which directory the observed `claude` is launched in.
 */
export function conanHookCommand(): string {
  return `node "${SEND_EVENT_SCRIPT}"`;
}

/** Where the user-level settings live; overridable for tests via env. */
export function globalSettingsPath(): string {
  return (
    process.env.CONAN_GLOBAL_SETTINGS ??
    path.join(HOME, ".claude", "settings.json")
  );
}

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

/** True when a matcher-group already forwards to OUR send-event.mjs. */
function groupHasConanHook(group: HookGroup): boolean {
  if (!Array.isArray(group?.hooks)) return false;
  return group.hooks.some(
    (h) =>
      typeof h?.command === "string" && h.command.includes(SEND_EVENT_SCRIPT),
  );
}

/** Build the Conan matcher-group for one event. */
function conanGroup(event: string, command: string): HookGroup {
  const group: HookGroup = { hooks: [{ type: "command", command }] };
  if (MATCHER_EVENTS.has(event)) group.matcher = "";
  return group;
}

export interface MergeResult {
  /** New settings object (a copy — the input is not mutated). */
  settings: Settings;
  /** True when at least one event group was added. */
  changed: boolean;
  /** Events that gained a Conan group on this merge. */
  added: string[];
}

/**
 * Merge Conan's global hooks into an existing settings object WITHOUT
 * clobbering. Preserves every unknown top-level key and every pre-existing
 * hook group; only appends a Conan group for an event that does not already
 * forward to send-event.mjs. Idempotent: a second run reports changed=false.
 */
export function mergeGlobalHooks(
  existing: Settings | null | undefined,
  command: string = conanHookCommand(),
): MergeResult {
  // Deep clone so callers' objects (and the on-disk file) are never mutated.
  const settings: Settings = existing
    ? (JSON.parse(JSON.stringify(existing)) as Settings)
    : {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const added: string[] = [];
  for (const event of CONAN_HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : (settings.hooks[event] = []);
    if (groups.some(groupHasConanHook)) continue; // already wired — idempotent
    groups.push(conanGroup(event, command));
    added.push(event);
  }
  return { settings, changed: added.length > 0, added };
}

/**
 * Remove Conan's global hook groups (uninstall). Drops only groups that forward
 * to send-event.mjs, leaves every other hook/group/key intact, and prunes an
 * event array that becomes empty so we don't leave dangling keys.
 */
export function removeGlobalHooks(existing: Settings | null | undefined): MergeResult {
  const settings: Settings = existing
    ? (JSON.parse(JSON.stringify(existing)) as Settings)
    : {};
  const added: string[] = [];
  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { settings, changed: false, added };
  }
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !groupHasConanHook(g));
    if (kept.length !== groups.length) changed = true;
    if (kept.length === 0) delete settings.hooks[event];
    else settings.hooks[event] = kept;
  }
  return { settings, changed, added };
}

function readSettings(file: string): Settings | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  } catch {
    return null; // missing or unparseable — treat as a fresh file
  }
}

function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export interface InstallResult {
  path: string;
  changed: boolean;
  added: string[];
  events: readonly string[];
  command: string;
}

export interface HooksStatus {
  path: string;
  /** True iff EVERY forwarded event already routes to send-event.mjs. */
  installed: boolean;
  /** Events with no Conan forwarder yet (what an install would add). */
  missing: string[];
  events: readonly string[];
  command: string;
}

/**
 * Report whether the global hooks are wired, without writing anything.
 * A dry-run of the merge: whatever it *would* add is what's missing.
 */
export function globalHooksStatus(): HooksStatus {
  const file = globalSettingsPath();
  const { changed, added } = mergeGlobalHooks(readSettings(file));
  return {
    path: file,
    installed: !changed,
    missing: added,
    events: CONAN_HOOK_EVENTS,
    command: conanHookCommand(),
  };
}

/**
 * Install (idempotently) the global hooks into ~/.claude/settings.json. Backs
 * up an existing file once before the first mutation, merges, and writes.
 */
export function installGlobalHooks(): InstallResult {
  const file = globalSettingsPath();
  const existing = readSettings(file);
  const { settings, changed, added } = mergeGlobalHooks(existing);
  if (changed) {
    if (existing && fs.existsSync(file)) {
      fs.copyFileSync(file, file + ".conan-bak");
    }
    writeSettings(file, settings);
  }
  return {
    path: file,
    changed,
    added,
    events: CONAN_HOOK_EVENTS,
    command: conanHookCommand(),
  };
}

/** Remove the global hooks again, preserving everything else. */
export function uninstallGlobalHooks(): InstallResult {
  const file = globalSettingsPath();
  const existing = readSettings(file);
  const { settings, changed } = removeGlobalHooks(existing);
  if (changed) {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".conan-bak");
    writeSettings(file, settings);
  }
  return {
    path: file,
    changed,
    added: [],
    events: CONAN_HOOK_EVENTS,
    command: conanHookCommand(),
  };
}
