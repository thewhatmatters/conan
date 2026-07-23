import fs from "node:fs";
import { execFile } from "node:child_process";
import { loginShellPath } from "../doctor/claude.js";

export interface CommandResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface PullRequestResult {
  ok: boolean;
  url?: string;
  error?: string;
  reason?: "gh-missing" | "gh-unauthed" | "not-github";
}

const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 45_000;

async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  const shellPath = await loginShellPath();
  return shellPath ? { ...process.env, PATH: shellPath } : process.env;
}

function runCommand(
  file: string,
  args: string[],
  cwd: string,
  timeout = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    commandEnv()
      .then((env) => {
        execFile(
          file,
          args,
          { cwd, env, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              reject(Object.assign(error, { stdout, stderr }));
              return;
            }
            resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          },
        );
      })
      .catch(reject);
  });
}

function commandError(error: unknown): string {
  const e = error as Error & { stderr?: string; stdout?: string; code?: string };
  return e.stderr?.trim() || e.stdout?.trim() || e.message || "command failed";
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function validateDirectory(cwd: string): string | null {
  if (!cwd.trim()) return "cwd required";
  if (!fs.existsSync(cwd)) return `no such directory: ${cwd}`;
  if (!fs.statSync(cwd).isDirectory()) return `not a directory: ${cwd}`;
  return null;
}

export async function ensureGitWorkTree(cwd: string): Promise<string | null> {
  const dirError = validateDirectory(cwd);
  if (dirError) return dirError;
  try {
    const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    return result.stdout === "true" ? null : `not a git work tree: ${cwd}`;
  } catch (error) {
    return commandError(error) || `not a git work tree: ${cwd}`;
  }
}

export async function commitAll(cwd: string, message: string): Promise<CommandResult> {
  const gitError = await ensureGitWorkTree(cwd);
  if (gitError) return { ok: false, error: gitError };
  if (!message.trim()) return { ok: false, error: "commit message required" };
  try {
    const add = await runCommand("git", ["add", "-A"], cwd);
    const commit = await runCommand("git", ["commit", "-m", message], cwd);
    return { ok: true, output: [combinedOutput(add), combinedOutput(commit)].filter(Boolean).join("\n") };
  } catch (error) {
    return { ok: false, error: commandError(error) };
  }
}

export async function pushCurrentBranch(cwd: string): Promise<CommandResult> {
  const gitError = await ensureGitWorkTree(cwd);
  if (gitError) return { ok: false, error: gitError };
  try {
    let args = ["push"];
    try {
      await runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
    } catch {
      const branch = (await runCommand("git", ["branch", "--show-current"], cwd)).stdout;
      if (!branch) return { ok: false, error: "cannot push detached HEAD" };
      args = ["push", "-u", "origin", branch];
    }
    const result = await runCommand("git", args, cwd);
    return { ok: true, output: combinedOutput(result) };
  } catch (error) {
    return { ok: false, error: commandError(error) };
  }
}

function isGitHubRemote(url: string): boolean {
  return /^git@github\.com:/i.test(url) || /^https:\/\/github\.com\//i.test(url);
}

function parseUrl(output: string): string | null {
  return /https:\/\/github\.com\/[^\s]+/i.exec(output)?.[0] ?? null;
}

export async function createPullRequest(
  cwd: string,
  title: string,
  body: string,
): Promise<PullRequestResult> {
  const gitError = await ensureGitWorkTree(cwd);
  if (gitError) return { ok: false, error: gitError };
  if (!title.trim()) return { ok: false, error: "title required" };
  try {
    const remote = await runCommand("git", ["remote", "get-url", "origin"], cwd);
    if (!isGitHubRemote(remote.stdout)) {
      return { ok: false, reason: "not-github", error: "origin remote is not GitHub" };
    }
  } catch {
    return { ok: false, reason: "not-github", error: "origin remote is not GitHub" };
  }

  try {
    await runCommand("gh", ["auth", "status"], cwd, GH_TIMEOUT_MS);
  } catch (error) {
    const e = error as Error & { code?: string };
    if (e.code === "ENOENT") {
      return { ok: false, reason: "gh-missing", error: "GitHub CLI (`gh`) is not installed" };
    }
    return { ok: false, reason: "gh-unauthed", error: commandError(error) };
  }

  try {
    const result = await runCommand(
      "gh",
      ["pr", "create", "--title", title, "--body", body],
      cwd,
      GH_TIMEOUT_MS,
    );
    const output = combinedOutput(result);
    const url = parseUrl(output);
    if (!url) return { ok: false, error: output || "gh did not return a pull request URL" };
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: commandError(error) };
  }
}
