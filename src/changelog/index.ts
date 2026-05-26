// US-007: changelog feed for the "What's New" view (US-030).
//
// Claude Code caches its own changelog at ~/.claude/cache/changelog.md. The
// format is uniform: a top `# Changelog` heading, then a `## <version>` heading
// per release (newest-first), followed by flat `- ` bullets. There are NO dates
// in the source, so every entry's `date` is null.
//
// We surface the installed version (from a live sessions/<pid>.json `version`,
// falling back to ~/.claude.json's lastReleaseNotesSeen) and flag every entry
// strictly newer than lastReleaseNotesSeen as `new` via a numeric semver-tuple
// compare. changelogLastFetched is the file mtime (epoch ms) for staleness.
//
// readChangelog() resolves its paths from the same CONAN_CLAUDE_DIR /
// CONAN_CLAUDE_JSON overrides the settings module uses, so tests can point it at
// a hermetic fixture. It never throws: a missing/unreadable file yields a safe
// empty shape.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

/** One parsed release: a version heading plus its flat bullet items. */
export interface ChangelogEntry {
  version: string;
  /** No dates exist in the source changelog → always null. */
  date: null;
  items: string[];
  /** True when this version is strictly newer than lastReleaseNotesSeen. */
  isNew: boolean;
}

export interface ChangelogPayload {
  /** Releases newest-first, as ordered in the source file. */
  entries: ChangelogEntry[];
  /** Installed Claude Code version (sessions/<pid>.json, else lastReleaseNotesSeen), or null. */
  installedVersion: string | null;
  /** The lastReleaseNotesSeen marker from ~/.claude.json, or null. */
  lastReleaseNotesSeen: string | null;
  /** changelog.md mtime in epoch ms (staleness signal), or null if absent. */
  changelogLastFetched: number | null;
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}
/** The ~/.claude.json file (overridable for tests via CONAN_CLAUDE_JSON). */
function dotClaudeJson(): string {
  return process.env.CONAN_CLAUDE_JSON ?? path.join(HOME, ".claude.json");
}
function changelogFile(): string {
  return path.join(claudeDir(), "cache", "changelog.md");
}

/** Parse a version string into a numeric tuple for ordering (non-numeric → 0). */
function semverTuple(v: string): number[] {
  return v
    .trim()
    .split(".")
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Compare two version strings as semver tuples. >0 when a is newer than b. */
function semverCompare(a: string, b: string): number {
  const ta = semverTuple(a);
  const tb = semverTuple(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const diff = (ta[i] ?? 0) - (tb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Parse the changelog markdown into ordered {version, items} entries. */
function parseChangelog(text: string): { version: string; items: string[] }[] {
  const entries: { version: string; items: string[] }[] = [];
  let current: { version: string; items: string[] } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { version: heading[1]!, items: [] };
      entries.push(current);
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet && current) {
      current.items.push(bullet[1]!);
    }
  }
  return entries;
}

/**
 * Resolve the installed version: prefer the `version` from the most recently
 * touched sessions/<pid>.json (the running CLI's true build), falling back to
 * ~/.claude.json's lastReleaseNotesSeen. Returns null when neither is available.
 */
function installedVersionFrom(lastSeen: string | null): string | null {
  const dir = path.join(claudeDir(), "sessions");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { full } of files) {
      try {
        const json = JSON.parse(fs.readFileSync(full, "utf8")) as { version?: unknown };
        if (typeof json.version === "string" && json.version) return json.version;
      } catch {
        // skip unparseable session file
      }
    }
  } catch {
    // no sessions dir
  }
  return lastSeen;
}

/** Read the lastReleaseNotesSeen marker from ~/.claude.json (null if absent). */
function lastReleaseNotesSeenFrom(): string | null {
  try {
    const json = JSON.parse(fs.readFileSync(dotClaudeJson(), "utf8")) as {
      lastReleaseNotesSeen?: unknown;
    };
    return typeof json.lastReleaseNotesSeen === "string" ? json.lastReleaseNotesSeen : null;
  } catch {
    return null;
  }
}

/**
 * Read and parse the local Claude Code changelog into a newest-first feed,
 * marking entries newer than lastReleaseNotesSeen as `new`. Never throws; a
 * missing changelog yields an empty entries list (other fields still resolved).
 */
export function readChangelog(): ChangelogPayload {
  const lastSeen = lastReleaseNotesSeenFrom();
  const installedVersion = installedVersionFrom(lastSeen);

  let text: string | null = null;
  let changelogLastFetched: number | null = null;
  try {
    const file = changelogFile();
    text = fs.readFileSync(file, "utf8");
    changelogLastFetched = fs.statSync(file).mtimeMs;
  } catch {
    text = null;
  }

  const parsed = text ? parseChangelog(text) : [];
  const entries: ChangelogEntry[] = parsed.map((e) => ({
    version: e.version,
    date: null,
    items: e.items,
    isNew: lastSeen ? semverCompare(e.version, lastSeen) > 0 : false,
  }));

  return { entries, installedVersion, lastReleaseNotesSeen: lastSeen, changelogLastFetched };
}
