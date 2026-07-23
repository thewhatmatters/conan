import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";

const ACTION_TIMEOUT_MS = 30_000;
const ACTION_MAX_BUFFER = 128 * 1024;

export interface ProjectAction {
  id: string;
  projectId: string;
  name: string;
  command: string;
  createdAt: number;
}

export interface ActionRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

function rowToAction(row: {
  id: string;
  project_id: string;
  name: string;
  command: string;
  created_at: number;
}): ProjectAction {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    command: row.command,
    createdAt: row.created_at,
  };
}

export function listProjectActions(projectId: string): ProjectAction[] {
  return (
    getDb()
      .prepare(
        `SELECT id, project_id, name, command, created_at
           FROM project_action
          WHERE project_id = ?
          ORDER BY created_at ASC`,
      )
      .all(projectId) as Parameters<typeof rowToAction>[0][]
  ).map(rowToAction);
}

export function addProjectAction(input: {
  projectId: string;
  name: string;
  command: string;
}): ProjectAction | { error: string } {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) return { error: "name required" };
  if (!command) return { error: "command required" };
  const project = getDb()
    .prepare("SELECT id FROM project WHERE id = ?")
    .get(input.projectId);
  if (!project) return { error: "project not found" };
  const action: ProjectAction = {
    id: randomUUID(),
    projectId: input.projectId,
    name,
    command,
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO project_action (id, project_id, name, command, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(action.id, action.projectId, action.name, action.command, action.createdAt);
  return action;
}

export function updateProjectAction(
  actionId: string,
  input: { name: string; command: string },
): ProjectAction | { error: string } {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) return { error: "name required" };
  if (!command) return { error: "command required" };
  const changed = getDb()
    .prepare("UPDATE project_action SET name = ?, command = ? WHERE id = ?")
    .run(name, command, actionId).changes;
  if (!changed) return { error: "action not found" };
  const target = getActionWithProject(actionId);
  return target ? target.action : { error: "action not found" };
}

export function deleteProjectAction(actionId: string): boolean {
  return getDb()
    .prepare("DELETE FROM project_action WHERE id = ?")
    .run(actionId).changes > 0;
}

function getActionWithProject(actionId: string):
  | { action: ProjectAction; cwd: string }
  | null {
  const row = getDb()
    .prepare(
      `SELECT a.id, a.project_id, a.name, a.command, a.created_at, p.path AS cwd
         FROM project_action a
         JOIN project p ON p.id = a.project_id
        WHERE a.id = ?`,
    )
    .get(actionId) as
    | {
        id: string;
        project_id: string;
        name: string;
        command: string;
        created_at: number;
        cwd: string;
      }
    | undefined;
  if (!row) return null;
  return { action: rowToAction(row), cwd: row.cwd };
}

function trimBounded(value: string): string {
  if (value.length <= ACTION_MAX_BUFFER) return value;
  return `${value.slice(0, ACTION_MAX_BUFFER)}\n[output truncated]`;
}

export function runProjectAction(actionId: string): Promise<ActionRunResult> {
  const target = getActionWithProject(actionId);
  if (!target) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "action not found",
    });
  }

  return new Promise((resolve) => {
    exec(
      target.action.command,
      {
        cwd: target.cwd,
        timeout: ACTION_TIMEOUT_MS,
        maxBuffer: ACTION_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        const e = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const timedOut = Boolean(e?.killed);
        const exitCode =
          typeof e?.code === "number" ? e.code : error ? 1 : 0;
        resolve({
          ok: !error,
          stdout: trimBounded(stdout),
          stderr: trimBounded(stderr),
          exitCode,
          timedOut,
          ...(error
            ? { error: timedOut ? "action timed out" : error.message }
            : {}),
        });
      },
    );
  });
}
