import fs from "node:fs";
import { execFile } from "node:child_process";
import { loginShellPath } from "../doctor/claude.js";

export type EditorId = "code" | "cursor" | "zed" | "idea" | "subl" | "finder";

export interface DetectedEditor {
  id: EditorId;
  name: string;
  path: string | null;
}

const EDITORS: ReadonlyArray<{
  id: Exclude<EditorId, "finder">;
  name: string;
  app: string;
}> = [
  { id: "code", name: "Visual Studio Code", app: "Visual Studio Code" },
  { id: "cursor", name: "Cursor", app: "Cursor" },
  { id: "zed", name: "Zed", app: "Zed" },
  { id: "idea", name: "JetBrains IntelliJ IDEA", app: "IntelliJ IDEA" },
  { id: "subl", name: "Sublime Text", app: "Sublime Text" },
];

const DETECT_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;

function exec(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: options.timeout ?? OPEN_TIMEOUT_MS,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Find supported editor CLIs using the same interactive-login-shell PATH that
 * the headless agent uses. Finder is always present as the safe macOS fallback.
 */
export async function detectEditors(): Promise<DetectedEditor[]> {
  const shellPath = await loginShellPath();
  const env = shellPath ? { ...process.env, PATH: shellPath } : process.env;
  const found = await Promise.all(
    EDITORS.map(async (editor): Promise<DetectedEditor | null> => {
      try {
        const path = await exec("which", [editor.id], {
          env,
          timeout: DETECT_TIMEOUT_MS,
        });
        return path ? { id: editor.id, name: editor.name, path } : null;
      } catch {
        return null;
      }
    }),
  );

  return [
    ...found.filter((editor): editor is DetectedEditor => editor !== null),
    { id: "finder", name: "Reveal in Finder", path: null },
  ];
}

/** Launch a directory in a supported editor without interpolating shell text. */
export async function openInEditor(
  rawPath: string,
  requestedEditor?: string,
): Promise<{ editor: EditorId }> {
  if (!fs.existsSync(rawPath)) throw new Error(`no such path: ${rawPath}`);
  if (!fs.statSync(rawPath).isDirectory()) {
    throw new Error(`not a directory: ${rawPath}`);
  }

  const editorId = requestedEditor || "finder";
  if (editorId === "finder") {
    await exec("open", [rawPath]);
    return { editor: "finder" };
  }

  const editor = EDITORS.find(({ id }) => id === editorId);
  if (!editor) throw new Error(`unsupported editor: ${editorId}`);

  const detected = (await detectEditors()).find(({ id }) => id === editor.id);
  try {
    if (detected?.path) {
      await exec(detected.path, [rawPath]);
    } else {
      await exec("open", ["-a", editor.app, rawPath]);
    }
  } catch (error) {
    throw new Error(`${editor.name} is unavailable: ${(error as Error).message}`);
  }
  return { editor: editor.id };
}
