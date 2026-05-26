// US-014: subagent reconstruction — rebuild a session's subagent tree from disk
// for ANY session (past, observed, or one Conan never launched), not just live
// ones tracked by parent_tool_use_id in the event store.
//
// Claude Code records each subagent run beside the parent transcript at
//   ~/.claude/projects/<encoded-cwd>/<session-id>/subagents/
//     agent-<id>.jsonl       — the subagent's own conversation (same JSONL shape
//                              as a main transcript; isSidechain:true)
//     agent-<id>.meta.json   — { agentType, description, toolUseId }
// where `toolUseId` is the id of the `Task` tool_use block (in the PARENT's
// transcript, or in another subagent's transcript) that spawned this subagent.
// We use that to assemble a real tree: a subagent whose toolUseId is found in the
// main session transcript is a root; one whose toolUseId is found inside another
// subagent's transcript nests under it. Subagents whose spawn point we can't
// locate are attached at the root so nothing is dropped.
//
// Read-only, never throws: a missing project/session/subagents dir, an empty
// dir, or unreadable files all yield a safe { found:false, subagents:[] } shape.
// Paths honor CONAN_CLAUDE_DIR (the same override the other disk readers use) so
// tests can point at a hermetic fixture; the user-supplied session id is matched
// against scanned directory names rather than joined into a path blindly.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { normalizeTranscriptLines, type TranscriptMessage } from "../transcript/index.js";

/** ~/.claude (overridable for tests via CONAN_CLAUDE_DIR). */
function claudeDir(): string {
  return process.env.CONAN_CLAUDE_DIR ?? path.join(HOME, ".claude");
}
function projectsDir(): string {
  return path.join(claudeDir(), "projects");
}

/** Encode a cwd the way Claude Code names its per-project folder. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** One reconstructed subagent: its meta, normalized transcript, and children. */
export interface SubagentNode {
  /** The `<id>` from agent-<id>.jsonl. */
  agentId: string;
  /** Agent type from meta (e.g. "Explore", "general-purpose"); null if absent. */
  agentType: string | null;
  /** Human description from meta; null if absent. */
  description: string | null;
  /** Parent Task tool_use id that spawned this subagent; null if absent. */
  toolUseId: string | null;
  /** The subagent's own conversation, in order. */
  transcript: TranscriptMessage[];
  /** Subagents this one spawned (nested via their toolUseId). */
  children: SubagentNode[];
}

export interface SubagentsResult {
  /** Whether a subagents directory was found for the session. */
  found: boolean;
  sessionId: string;
  /** Absolute subagents dir read, or null when not found. */
  dir: string | null;
  /** Root subagents (spawned by the main session), each with nested children. */
  subagents: SubagentNode[];
}

/** A subagent before tree assembly: meta + transcript + the ids it itself spawned. */
interface RawSubagent {
  node: SubagentNode;
  /** tool_use ids appearing in THIS subagent's transcript (its spawn points). */
  ownToolUseIds: Set<string>;
}

/**
 * Locate the `<session-id>/subagents` directory. Prefers the folder derived from
 * a known cwd; otherwise scans every project folder for a matching session dir,
 * so a session whose cwd we don't have still resolves. Returns null when none
 * exists.
 */
function subagentsDir(sessionId: string, cwd?: string | null): string | null {
  if (!sessionId) return null;
  const root = projectsDir();
  const tryDir = (projectDir: string): string | null => {
    const candidate = path.join(projectDir, sessionId, "subagents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not here */
    }
    return null;
  };
  if (cwd) {
    const direct = tryDir(path.join(root, encodeCwd(cwd)));
    if (direct) return direct;
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const found = tryDir(path.join(root, dir));
    if (found) return found;
  }
  return null;
}

/** The main session transcript file, used to find which subagents are roots. */
function mainTranscriptFile(sessionId: string, dir: string): string | null {
  // dir is <project>/<session-id>/subagents → the transcript is the sibling
  // <project>/<session-id>.jsonl.
  const sessionDir = path.dirname(dir); // <project>/<session-id>
  const candidate = `${sessionDir}.jsonl`;
  return fs.existsSync(candidate) ? candidate : null;
}

/** Collect every assistant tool_use `id` in a transcript's raw JSONL. */
function collectToolUseIds(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "assistant") continue;
    const msg = (o.message ?? {}) as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const raw2 of content) {
      const b = raw2 as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.id === "string") ids.add(b.id);
    }
  }
  return ids;
}

/** Parse `agent-<id>.jsonl` / `agent-<id>.meta.json` → the `<id>` stem, or null. */
function agentIdFromName(name: string): string | null {
  const m = /^agent-([^.]+)\.(jsonl|meta\.json)$/.exec(name);
  return m && m[1] ? m[1] : null;
}

/**
 * Reconstruct a session's subagent tree from disk (US-014). Returns roots (each
 * with nested children) plus every subagent's normalized transcript. Works for
 * sessions Conan never launched; a session with no subagents (or no project
 * folder) yields { found:false, subagents:[] }.
 */
export function readSubagents(sessionId: string, cwd?: string | null): SubagentsResult {
  const dir = subagentsDir(sessionId, cwd);
  if (!dir) return { found: false, sessionId, dir: null, subagents: [] };

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { found: false, sessionId, dir: null, subagents: [] };
  }

  // Collect distinct agent ids (a subagent may have both .jsonl and .meta.json).
  const agentIds = new Set<string>();
  for (const name of names) {
    const id = agentIdFromName(name);
    if (id) agentIds.add(id);
  }
  if (agentIds.size === 0) {
    return { found: true, sessionId, dir, subagents: [] };
  }

  const raws: RawSubagent[] = [];
  for (const agentId of agentIds) {
    // Transcript
    let transcript: TranscriptMessage[] = [];
    let ownToolUseIds = new Set<string>();
    try {
      const body = fs.readFileSync(path.join(dir, `agent-${agentId}.jsonl`), "utf8");
      transcript = normalizeTranscriptLines(body);
      ownToolUseIds = collectToolUseIds(body);
    } catch {
      /* no/unreadable transcript → empty */
    }
    // Meta
    let agentType: string | null = null;
    let description: string | null = null;
    let toolUseId: string | null = null;
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), "utf8"),
      ) as Record<string, unknown>;
      if (typeof meta.agentType === "string") agentType = meta.agentType;
      if (typeof meta.description === "string") description = meta.description;
      if (typeof meta.toolUseId === "string") toolUseId = meta.toolUseId;
    } catch {
      /* no/unreadable meta → nulls */
    }
    raws.push({
      node: { agentId, agentType, description, toolUseId, transcript, children: [] },
      ownToolUseIds,
    });
  }

  // tool_use ids in the MAIN session transcript → those subagents are roots.
  let mainIds = new Set<string>();
  const mainFile = mainTranscriptFile(sessionId, dir);
  if (mainFile) {
    try {
      mainIds = collectToolUseIds(fs.readFileSync(mainFile, "utf8"));
    } catch {
      /* keep empty */
    }
  }

  // Map each spawn-point tool_use id → the subagent that owns it, so a subagent
  // whose toolUseId lives inside another subagent's transcript nests under it.
  const ownerByToolUseId = new Map<string, RawSubagent>();
  for (const r of raws) {
    for (const id of r.ownToolUseIds) ownerByToolUseId.set(id, r);
  }

  const roots: SubagentNode[] = [];
  for (const r of raws) {
    const tid = r.node.toolUseId;
    const parent = tid ? ownerByToolUseId.get(tid) : undefined;
    // A subagent never parents itself (guard against a self-referential id).
    if (parent && parent !== r && !(tid && mainIds.has(tid))) {
      parent.node.children.push(r.node);
    } else {
      roots.push(r.node);
    }
  }

  // Stable ordering: by first message timestamp, then agentId.
  const sortRec = (nodes: SubagentNode[]): void => {
    nodes.sort((a, b) => {
      const ta = a.transcript[0]?.ts ?? 0;
      const tb = b.transcript[0]?.ts ?? 0;
      return ta - tb || a.agentId.localeCompare(b.agentId);
    });
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);

  return { found: true, sessionId, dir, subagents: roots };
}
