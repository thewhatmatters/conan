import { randomUUID } from "node:crypto";
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
  title: string | null;
  createdAt: number;
  lastActivity: number;
}

export interface ProjectWithThreads extends ProjectRow {
  /** Newest activity first. */
  threads: ThreadRow[];
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
      `SELECT session_id, project_id, cwd, model, title, created_at, last_activity
         FROM chat_thread ORDER BY last_activity DESC`,
    )
    .all() as {
    session_id: string;
    project_id: string;
    cwd: string;
    model: string | null;
    title: string | null;
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
      title: t.title,
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
  title: string | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO chat_thread (session_id, project_id, cwd, model, title, created_at, last_activity)
       VALUES (@sessionId, @projectId, @cwd, @model, @title, @now, @now)
       ON CONFLICT(session_id) DO UPDATE SET
         model = COALESCE(excluded.model, chat_thread.model),
         title = COALESCE(chat_thread.title, excluded.title),
         last_activity = excluded.last_activity`,
    )
    .run({ ...t, now });
}

/** Bump a thread's last_activity (turn completed). Unknown ids are a no-op. */
export function touchChatThread(sessionId: string): void {
  getDb()
    .prepare("UPDATE chat_thread SET last_activity = ? WHERE session_id = ?")
    .run(Date.now(), sessionId);
}

/** Delete a thread row (the sidebar's close-X). The project persists. */
export function deleteChatThread(sessionId: string): boolean {
  const info = getDb()
    .prepare("DELETE FROM chat_thread WHERE session_id = ?")
    .run(sessionId);
  return info.changes > 0;
}
