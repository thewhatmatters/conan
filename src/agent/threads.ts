import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";

/**
 * Chat persistence store (US-014) over the US-013 `project` + `chat_thread`
 * tables. Projects are upserted by PATH (the UNIQUE key — adding the same
 * folder twice is one project); threads are keyed by Claude's session_id (the
 * resume key for US-015). No message content lives here — transcripts are
 * reconstructed from Claude's own JSONL.
 */

export interface ProjectRow {
  id: string;
  path: string;
  name: string;
  createdAt: number;
}

export interface ThreadRow {
  sessionId: string;
  projectId: string;
  cwd: string;
  model: string | null;
  /** T3-1 US-006: agent provider id that drives the thread ('claude' | 'codex'
   *  | 'grok'). Pre-multi-provider rows (stored null) read as 'claude' — a
   *  resume must relaunch the thread's OWN provider, never the default. */
  provider: string;
  effort: string | null;
  title: string | null;
  /** PD-1: preview of the last assistant response (or prompt) for the sidebar
   *  row's description line. Null for pre-PD-1 rows / threads with no turn yet. */
  lastMessage: string | null;
  createdAt: number;
  lastActivity: number;
}

export interface ProjectWithThreads extends ProjectRow {
  /** Git repository root containing the project folder (null when the folder
   *  isn't inside a repo, or no longer exists) — the sidebar's group-by-
   *  repository key (US-005). */
  repoRoot: string | null;
  /** Newest activity first. */
  threads: ThreadRow[];
}

/** Nearest ancestor (or the folder itself) containing a `.git` entry. Pure
 *  stat-walk — no git exec — so listing projects stays cheap. */
function findRepoRoot(dir: string): string | null {
  try {
    let cur = dir;
    for (;;) {
      if (fs.existsSync(path.join(cur, ".git"))) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  } catch {
    return null;
  }
}

/** Upsert a project by path — an existing row for the same folder is returned
 *  as-is (its id is stable across app reloads; the sidebar keys on it). */
export function upsertChatProject(dirPath: string, name?: string): ProjectRow {
  const db = getDb();
  const clean = dirPath.replace(/\/+$/, "") || "/";
  const existing = db
    .prepare("SELECT id, path, name, created_at FROM project WHERE path = ?")
    .get(clean) as { id: string; path: string; name: string; created_at: number } | undefined;
  if (existing) {
    return {
      id: existing.id,
      path: existing.path,
      name: existing.name,
      createdAt: existing.created_at,
    };
  }
  const row: ProjectRow = {
    id: randomUUID(),
    path: clean,
    name: name?.trim() || path.basename(clean) || clean,
    createdAt: Date.now(),
  };
  db.prepare("INSERT INTO project (id, path, name, created_at) VALUES (?, ?, ?, ?)").run(
    row.id,
    row.path,
    row.name,
    row.createdAt,
  );
  return row;
}

/** Every project with its threads, both newest-activity-first. A project with
 *  no threads still lists (it persists until explicitly deleted). */
export function listChatProjects(): ProjectWithThreads[] {
  const db = getDb();
  const projects = db
    .prepare("SELECT id, path, name, created_at FROM project")
    .all() as { id: string; path: string; name: string; created_at: number }[];
  const threads = db
    .prepare(
      `SELECT session_id, project_id, cwd, model, provider, effort, title, last_message, created_at, last_activity
         FROM chat_thread ORDER BY last_activity DESC`,
    )
    .all() as {
    session_id: string;
    project_id: string;
    cwd: string;
    model: string | null;
    provider: string | null;
    effort: string | null;
    title: string | null;
    last_message: string | null;
    created_at: number;
    last_activity: number;
  }[];
  const byProject = new Map<string, ThreadRow[]>();
  for (const t of threads) {
    const list = byProject.get(t.project_id) ?? [];
    list.push({
      sessionId: t.session_id,
      projectId: t.project_id,
      cwd: t.cwd,
      model: t.model,
      provider: t.provider ?? "claude",
      effort: t.effort,
      title: t.title,
      lastMessage: t.last_message,
      createdAt: t.created_at,
      lastActivity: t.last_activity,
    });
    byProject.set(t.project_id, list);
  }
  const rows: ProjectWithThreads[] = projects.map((p) => ({
    id: p.id,
    path: p.path,
    name: p.name,
    createdAt: p.created_at,
    repoRoot: findRepoRoot(p.path),
    threads: byProject.get(p.id) ?? [],
  }));
  // Newest activity first; a thread-less project sorts by its creation time.
  const activity = (p: ProjectWithThreads): number =>
    p.threads[0]?.lastActivity ?? p.createdAt;
  rows.sort((a, b) => activity(b) - activity(a));
  return rows;
}

/** Upsert a thread at session-init. A re-init of a known session bumps
 *  activity and fills model/title if they were empty; it never overwrites an
 *  existing title (first-prompt titles are sticky). Throws if the project row
 *  is missing (FK) — callers guard. */
export function upsertChatThread(t: {
  sessionId: string;
  projectId: string;
  cwd: string;
  model: string | null;
  /** T3-1 US-006: the provider that launched the session. Sticky — a thread
   *  never changes provider, so a conflicting upsert keeps the original. */
  provider: string | null;
  effort?: string | null;
  title: string | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO chat_thread (session_id, project_id, cwd, model, provider, effort, title, created_at, last_activity)
       VALUES (@sessionId, @projectId, @cwd, @model, @provider, @effort, @title, @now, @now)
       ON CONFLICT(session_id) DO UPDATE SET
         model = COALESCE(excluded.model, chat_thread.model),
         provider = COALESCE(chat_thread.provider, excluded.provider),
         effort = COALESCE(chat_thread.effort, excluded.effort),
         title = COALESCE(chat_thread.title, excluded.title),
         last_activity = excluded.last_activity`,
    )
    .run({ ...t, effort: t.effort ?? null, now });
}

/** One thread row by session id (US-015: the transcript route needs its cwd
 *  to locate the JSONL). Null when unknown. */
export function getChatThread(sessionId: string): ThreadRow | null {
  const row = getDb()
    .prepare(
      `SELECT session_id, project_id, cwd, model, provider, effort, title, last_message, created_at, last_activity
         FROM chat_thread WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        session_id: string;
        project_id: string;
        cwd: string;
        model: string | null;
        provider: string | null;
        effort: string | null;
        title: string | null;
        last_message: string | null;
        created_at: number;
        last_activity: number;
      }
    | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    cwd: row.cwd,
    model: row.model,
    provider: row.provider ?? "claude",
    effort: row.effort,
    title: row.title,
    lastMessage: row.last_message,
    createdAt: row.created_at,
    lastActivity: row.last_activity,
  };
}

/** Re-key a thread row after a resume (US-015): `claude --resume` forks the
 *  conversation into a NEW session id, so the saved row follows it — title,
 *  created_at and project stay; the sidebar never shows the thread twice.
 *  No-ops when the ids match, the old row is gone, or the new id already has
 *  a row (the session-init upsert lost the race — the old row is dropped so
 *  the thread still lists once). */
export function adoptChatThread(oldSessionId: string, newSessionId: string): void {
  if (oldSessionId === newSessionId) return;
  const db = getDb();
  const clash = db
    .prepare("SELECT 1 FROM chat_thread WHERE session_id = ?")
    .get(newSessionId);
  if (clash) {
    db.prepare("DELETE FROM chat_thread WHERE session_id = ?").run(oldSessionId);
    return;
  }
  db.prepare(
    "UPDATE chat_thread SET session_id = ?, last_activity = ? WHERE session_id = ?",
  ).run(newSessionId, Date.now(), oldSessionId);
}

/** Bump a thread's last_activity (turn completed). Unknown ids are a no-op. */
export function touchChatThread(sessionId: string): void {
  getDb()
    .prepare("UPDATE chat_thread SET last_activity = ? WHERE session_id = ?")
    .run(Date.now(), sessionId);
}

/** PD-1: set the thread's last_message preview (sidebar row description).
 *  Whitespace-collapsed + capped; unknown ids are a no-op. Best-effort. */
export function setChatThreadLastMessage(sessionId: string, text: string): void {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!preview) return;
  getDb()
    .prepare("UPDATE chat_thread SET last_message = ? WHERE session_id = ?")
    .run(preview, sessionId);
}

/** Rename a thread (sidebar context menu). Trims + caps the title; an empty
 *  title clears it back to null (the row falls back to "New chat"). Returns
 *  false when the id is unknown. */
export function renameChatThread(sessionId: string, title: string): boolean {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 200);
  const info = getDb()
    .prepare("UPDATE chat_thread SET title = ? WHERE session_id = ?")
    .run(clean || null, sessionId);
  return info.changes > 0;
}

/** Delete a thread row (the sidebar's close-X). The project persists. */
export function deleteChatThread(sessionId: string): boolean {
  const info = getDb()
    .prepare("DELETE FROM chat_thread WHERE session_id = ?")
    .run(sessionId);
  return info.changes > 0;
}

/** Remove a project from Conan (metadata-only — never touches the folder on
 *  disk). Its threads + actions go via ON DELETE CASCADE. Returns the distinct
 *  thread cwds that existed so the caller can prune any Conan-managed
 *  worktrees the removed threads left behind. */
export function deleteChatProject(projectId: string): {
  deleted: boolean;
  cwds: string[];
} {
  const db = getDb();
  const cwds = (
    db
      .prepare("SELECT DISTINCT cwd FROM chat_thread WHERE project_id = ?")
      .all(projectId) as { cwd: string }[]
  ).map((r) => r.cwd);
  const info = db.prepare("DELETE FROM project WHERE id = ?").run(projectId);
  return { deleted: info.changes > 0, cwds };
}

/** Number of saved threads sharing a working directory. */
export function countThreadsByCwd(cwd: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM chat_thread WHERE cwd = ?")
    .get(cwd) as { count: number };
  return row.count;
}
