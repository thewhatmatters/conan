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

/** Skill directories we scan, in scope order (user, then project). */
function skillRoots(): string[] {
  return [
    path.join(HOME, ".claude", "skills"),
    path.join(PACKAGE_ROOT, ".claude", "skills"),
  ];
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
