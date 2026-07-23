import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";

const ACTION_TIMEOUT_MS = 30_000;
const ACTION_MAX_BUFFER = 128 * 1024;

/** Actions are stored as repo-tracked markdown at `<project>/.conan/actions.md`
 *  (portable, shareable, git-versioned, hand-editable) rather than in SQLite —
 *  they're project tooling, like package.json scripts or .claude/commands. A
 *  `shell` action runs in a shell and shows its output; a `prompt` action is
 *  sent to the chat as a message (handled in the UI, never shelled out). */
export type ActionKind = "shell" | "prompt";

export interface ProjectAction {
  /** Slug of the name — stable + unique within a project (its file key). */
  id: string;
  projectId: string;
  name: string;
  kind: ActionKind;
  /** Shell command (kind=shell) or the prompt text (kind=prompt). */
  command: string;
}

export interface ActionRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

const FILE_HEADER = `# Conan actions

<!-- Custom toolbar actions for this project, managed by Conan — safe to hand-edit.
     Each "## Name" is one action. "Kind: shell" runs the command in a shell and
     shows its output; "Kind: prompt" sends the text to the chat as a message.
     Note: shell actions run arbitrary commands on whoever opens this repo. -->
`;

function projectPath(projectId: string): string | null {
  const row = getDb()
    .prepare("SELECT path FROM project WHERE id = ?")
    .get(projectId) as { path?: string } | undefined;
  return row?.path ?? null;
}

function actionsFile(dir: string): string {
  return path.join(dir, ".conan", "actions.md");
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "action"
  );
}

function serialize(actions: ProjectAction[]): string {
  const blocks = actions.map((a) => {
    const fence = a.kind === "prompt" ? "text" : "sh";
    return `## ${a.name}\n\n**Kind:** ${a.kind}\n\n\`\`\`${fence}\n${a.command}\n\`\`\`\n`;
  });
  return `${FILE_HEADER}\n${blocks.join("\n")}`;
}

function parse(content: string, projectId: string): ProjectAction[] {
  const lines = content.split("\n");
  const actions: ProjectAction[] = [];
  let i = 0;
  while (i < lines.length) {
    const heading = (lines[i] ?? "").match(/^##\s+(.+?)\s*$/);
    if (!heading?.[1]) {
      i++;
      continue;
    }
    const name = heading[1].trim();
    i++;
    let kind: ActionKind = "shell";
    let command = "";
    // Consume the section until the next "## " heading.
    while (i < lines.length && !/^##\s+/.test(lines[i] ?? "")) {
      const line = lines[i] ?? "";
      const k = line.match(/^\*\*Kind:\*\*\s*(shell|prompt)/i);
      if (k?.[1]) {
        kind = k[1].toLowerCase() as ActionKind;
        i++;
        continue;
      }
      if (/^```/.test(line)) {
        i++;
        const body: string[] = [];
        while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
          body.push(lines[i] ?? "");
          i++;
        }
        i++; // closing fence
        command = body.join("\n").trim();
        continue;
      }
      i++;
    }
    if (name) actions.push({ id: slug(name), projectId, name, kind, command });
  }
  // Disambiguate colliding slugs so ids stay unique within the file.
  const seen = new Map<string, number>();
  for (const a of actions) {
    const n = seen.get(a.id) ?? 0;
    if (n > 0) a.id = `${a.id}-${n + 1}`;
    seen.set(a.id, n + 1);
  }
  return actions;
}

function writeActions(projectId: string, actions: ProjectAction[]): void {
  const dir = projectPath(projectId);
  if (!dir) throw new Error("project not found");
  const file = actionsFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialize(actions));
}

/** One-time seed: if there's no actions.md yet but the legacy SQLite table has
 *  rows for this project (pre-markdown builds), migrate them into the file. */
function migrateLegacyIfNeeded(projectId: string, dir: string): void {
  if (fs.existsSync(actionsFile(dir))) return;
  let rows: Array<{ name: string; command: string }> = [];
  try {
    rows = getDb()
      .prepare(
        "SELECT name, command FROM project_action WHERE project_id = ? ORDER BY created_at ASC",
      )
      .all(projectId) as Array<{ name: string; command: string }>;
  } catch {
    rows = [];
  }
  if (!rows.length) return;
  writeActions(
    projectId,
    rows.map((r) => ({
      id: slug(r.name),
      projectId,
      name: r.name,
      kind: "shell" as const,
      command: r.command,
    })),
  );
}

export function listProjectActions(projectId: string): ProjectAction[] {
  const dir = projectPath(projectId);
  if (!dir) return [];
  migrateLegacyIfNeeded(projectId, dir);
  const file = actionsFile(dir);
  if (!fs.existsSync(file)) return [];
  try {
    return parse(fs.readFileSync(file, "utf8"), projectId);
  } catch {
    return [];
  }
}

export function addProjectAction(input: {
  projectId: string;
  name: string;
  command: string;
  kind?: ActionKind;
}): ProjectAction | { error: string } {
  const name = input.name.trim();
  const command = input.command.trim();
  const kind: ActionKind = input.kind === "prompt" ? "prompt" : "shell";
  if (!name) return { error: "name required" };
  if (!command) return { error: "command required" };
  if (!projectPath(input.projectId)) return { error: "project not found" };
  const actions = listProjectActions(input.projectId);
  if (actions.some((a) => a.name.toLowerCase() === name.toLowerCase()))
    return { error: "an action with that name already exists" };
  writeActions(input.projectId, [
    ...actions,
    { id: slug(name), projectId: input.projectId, name, kind, command },
  ]);
  return (
    listProjectActions(input.projectId).find((a) => a.name === name) ?? {
      id: slug(name),
      projectId: input.projectId,
      name,
      kind,
      command,
    }
  );
}

export function updateProjectAction(
  projectId: string,
  actionId: string,
  input: { name: string; command: string; kind?: ActionKind },
): ProjectAction | { error: string } {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) return { error: "name required" };
  if (!command) return { error: "command required" };
  const actions = listProjectActions(projectId);
  const idx = actions.findIndex((a) => a.id === actionId);
  const current = actions[idx];
  if (idx < 0 || !current) return { error: "action not found" };
  if (actions.some((a, j) => j !== idx && a.name.toLowerCase() === name.toLowerCase()))
    return { error: "an action with that name already exists" };
  const kind: ActionKind = input.kind ?? current.kind;
  const updated: ProjectAction = {
    ...current,
    name,
    command,
    kind: kind === "prompt" ? "prompt" : "shell",
  };
  actions[idx] = updated;
  writeActions(projectId, actions);
  return listProjectActions(projectId).find((a) => a.name === name) ?? updated;
}

export function deleteProjectAction(projectId: string, actionId: string): boolean {
  const actions = listProjectActions(projectId);
  const next = actions.filter((a) => a.id !== actionId);
  if (next.length === actions.length) return false;
  writeActions(projectId, next);
  return true;
}

function trimBounded(value: string): string {
  if (value.length <= ACTION_MAX_BUFFER) return value;
  return `${value.slice(0, ACTION_MAX_BUFFER)}\n[output truncated]`;
}

export function runProjectAction(
  projectId: string,
  actionId: string,
): Promise<ActionRunResult> {
  const dir = projectPath(projectId);
  const action = dir
    ? listProjectActions(projectId).find((a) => a.id === actionId)
    : undefined;
  if (!dir || !action) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "action not found",
    });
  }
  if (action.kind === "prompt") {
    // Prompt actions are sent to the chat by the UI — they never shell out.
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "prompt actions run in the chat, not the shell",
    });
  }

  return new Promise((resolve) => {
    exec(
      action.command,
      { cwd: dir, timeout: ACTION_TIMEOUT_MS, maxBuffer: ACTION_MAX_BUFFER },
      (error, stdout, stderr) => {
        const e = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const timedOut = Boolean(e?.killed);
        const exitCode = typeof e?.code === "number" ? e.code : error ? 1 : 0;
        resolve({
          ok: !error,
          stdout: trimBounded(stdout),
          stderr: trimBounded(stderr),
          exitCode,
          timedOut,
          ...(error ? { error: timedOut ? "action timed out" : error.message } : {}),
        });
      },
    );
  });
}
