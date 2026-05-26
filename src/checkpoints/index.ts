// US-008: checkpoints — list Claude Code's per-session file-history snapshots
// (read-only).
//
// Claude Code stores file checkpoints under
//   ~/.claude/file-history/<session-id>/<hash>@v<N>
// where each `<hash>@v<N>` file is a FULL snapshot of one tracked file at one
// revision (not a diff). There is no manifest: the `<hash>` groups revisions of
// the same file, and the trailing `@v<N>` is its monotonically-rising version.
// We order revisions by version (then mtime) and sessions by most-recent
// activity.
//
// This module is read-only — listing + single-snapshot content preview. Restore
// is deliberately out of scope (deferred / risky). It never throws: a missing
// file-history dir, an empty session dir, or an unreadable file all yield a safe
// shape. Paths resolve from CONAN_CLAUDE_DIR (same override the other readers
// use) so tests can point it at a hermetic fixture, and lookups are done by
// scanning the real directory — user-supplied ids/hashes are never joined into a
// path directly (no traversal).

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";

/** One file snapshot: a hash (file identity) + its @vN revision + mtime. */
export interface CheckpointSnapshot {
  sessionId: string;
  /** Content-addressed file identity; revisions of one file share a hash. */
  hash: string;
  /** The @vN suffix as a number (e.g. `…@v3` → 3), or null if unparseable. */
  version: number | null;
  /** Snapshot file mtime in epoch ms. */
  mtime: number;
}

/** All snapshots for one session, newest revision first. */
export interface CheckpointSession {
  sessionId: string;
  snapshots: CheckpointSnapshot[];
  /** Most-recent snapshot mtime in the session (for sorting/staleness). */
  latestMtime: number;
}

export interface CheckpointsPayload {
  sessions: CheckpointSession[];
}

/** The ~/.claude directory (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}
function fileHistoryDir(): string {
  return path.join(claudeDir(), "file-history");
}

/** Parse a snapshot filename `<hash>@v<N>` into {hash, version}. */
function parseSnapshotName(name: string): { hash: string; version: number | null } | null {
  const at = name.lastIndexOf("@v");
  if (at <= 0) return null;
  const hash = name.slice(0, at);
  const verStr = name.slice(at + 2);
  const v = parseInt(verStr, 10);
  return { hash, version: Number.isFinite(v) ? v : null };
}

/** List one session's snapshots, newest revision first (version, then mtime). */
function readSessionSnapshots(sessionId: string): CheckpointSnapshot[] {
  const dir = path.join(fileHistoryDir(), sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const snaps: CheckpointSnapshot[] = [];
  for (const name of names) {
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    let mtime = 0;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    snaps.push({ sessionId, hash: parsed.hash, version: parsed.version, mtime });
  }
  // Newest first: by version desc within a hash is implied; globally sort by
  // mtime desc, falling back to version when equal.
  snaps.sort((a, b) => b.mtime - a.mtime || (b.version ?? 0) - (a.version ?? 0));
  return snaps;
}

/**
 * List every session's file-history snapshots, grouped per session and sorted
 * most-recently-active first. Empty / missing file-history dir → { sessions: [] }.
 */
export function readCheckpoints(): CheckpointsPayload {
  let sessionIds: string[];
  try {
    sessionIds = fs
      .readdirSync(fileHistoryDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { sessions: [] };
  }

  const sessions: CheckpointSession[] = [];
  for (const sessionId of sessionIds) {
    const snapshots = readSessionSnapshots(sessionId);
    if (snapshots.length === 0) continue; // skip empty session dirs
    const latestMtime = snapshots.reduce((m, s) => Math.max(m, s.mtime), 0);
    sessions.push({ sessionId, snapshots, latestMtime });
  }
  sessions.sort((a, b) => b.latestMtime - a.latestMtime);
  return { sessions };
}

export interface SnapshotContent {
  sessionId: string;
  hash: string;
  version: number | null;
  mtime: number;
  content: string;
}

/**
 * Read a single snapshot's content for preview (read-only). The match is found
 * by scanning the session directory — the requested hash/version are compared
 * against parsed filenames, so user input is never joined into a path (no
 * traversal). Returns null when the session or snapshot can't be found/read.
 */
export function readSnapshot(
  sessionId: string,
  hash: string,
  version: number | null,
): SnapshotContent | null {
  if (!sessionId || !hash) return null;
  const dir = path.join(fileHistoryDir(), sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const parsed = parseSnapshotName(name);
    if (!parsed || parsed.hash !== hash) continue;
    if (version != null && parsed.version !== version) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      const content = fs.readFileSync(full, "utf8");
      return { sessionId, hash, version: parsed.version, mtime: st.mtimeMs, content };
    } catch {
      return null;
    }
  }
  return null;
}
