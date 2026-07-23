import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { detectClaude, loginShellPath } from "../doctor/claude.js";
import type { AgentDriver, AgentEvent, AgentLaunchOpts } from "./driver.js";

/**
 * Claude Code headless driver (Level-2 chat spike).
 *
 * Drives `claude` in stream-json mode — the documented Agent-SDK transport:
 *
 *   claude --print --output-format stream-json --input-format stream-json \
 *          --verbose [--model X] [--permission-mode Y]
 *
 * With `--input-format stream-json` the process stays alive and reads one JSON
 * user message per line from stdin, so a single process carries a multi-turn
 * conversation. stdout is NDJSON lifecycle events (system/assistant/user/
 * result) which we parse into the normalized `AgentEvent` union.
 *
 * Spike scope: message-level streaming (whole assistant blocks, not partial
 * tokens — `--include-partial-messages` is the follow-up), interrupt = kill,
 * and launch config is fixed at the first prompt.
 */
export class ClaudeDriver implements AgentDriver {
  readonly provider = "claude";
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private opts: AgentLaunchOpts = {};

  constructor(
    private readonly emit: (e: AgentEvent) => void,
    /** Fallback cwd when the first prompt carries none — evaluated at spawn
     *  time (not boot) so it tracks the gateway's live active cwd. */
    private readonly fallbackCwd: () => string | null,
  ) {}

  async send(text: string, opts: AgentLaunchOpts): Promise<void> {
    if (this.disposed) return;
    if (!this.child && !this.starting) {
      this.opts = opts; // first prompt fixes the launch config
      this.starting = this.spawnClaude();
    }
    if (this.starting) await this.starting;
    if (!this.child) return; // spawn failed — an `error` event was already emitted
    // stream-json input: one JSON user message per line. The prompt text rides
    // stdin (never an argv), so there is no shell-quoting / injection surface.
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    this.child.stdin.write(msg + "\n");
  }

  interrupt(): void {
    // Spike: no in-band interrupt control frame yet — killing the process ends
    // the session. The UI treats the resulting `exit` as "chat ended".
    this.child?.kill("SIGINT");
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* stdin may already be closed */
      }
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  private async spawnClaude(): Promise<void> {
    // Resolve the binary the same way the rest of Conan does: explicit override,
    // else the doctor's shell-resolved absolute path, else bare `claude` on PATH.
    // Both the doctor probe and `loginShellPath()` run through an interactive
    // login shell (`zsh -i -l`, mirroring the pty's resolveCommand) so a
    // Finder-launched bundle sees the user's real PATH — and claude's own
    // subprocesses (node, git, rg) resolve too, via the merged env below.
    const [detection, shellPath] = await Promise.all([
      detectClaude(),
      loginShellPath(),
    ]);
    const bin = process.env.CONAN_CLAUDE_BIN || detection.path || "claude";
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (shellPath) env.PATH = shellPath;
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.permissionMode)
      args.push("--permission-mode", this.opts.permissionMode);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        cwd: this.opts.cwd ?? this.fallbackCwd() ?? process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit({ kind: "error", message: (err as Error).message });
      this.starting = null;
      return;
    }
    this.child = child;
    this.starting = null;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    // stderr is diagnostics only (job-control notices, model warnings); log a
    // bounded slice rather than parse it.
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.warn(`[agent] claude stderr: ${s.slice(0, 400)}`);
    });
    child.on("error", (err) =>
      this.emit({ kind: "error", message: err.message }),
    );
    child.on("exit", (code) => {
      this.child = null;
      if (!this.disposed) this.emit({ kind: "exit", code });
    });
  }

  /** Parse one NDJSON line from claude's stdout into normalized event(s). */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON noise
    }
    const type = msg.type;

    if (type === "system" && msg.subtype === "init") {
      this.emit({
        kind: "system",
        sessionId: str(msg.session_id),
        model: str(msg.model),
        cwd: str(msg.cwd),
        tools: Array.isArray(msg.tools)
          ? msg.tools.filter((t): t is string => typeof t === "string")
          : [],
      });
      return;
    }

    if (type === "assistant") {
      const content = messageContent(msg.message);
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim())
            this.emit({ kind: "assistant-text", text: block.text });
        } else if (block.type === "tool_use") {
          this.emit({
            kind: "tool-use",
            id: str(block.id) ?? "",
            name: str(block.name) ?? "tool",
            input: block.input ?? null,
          });
        }
      }
      return;
    }

    if (type === "user") {
      // Tool results come back as a user message carrying tool_result blocks.
      const content = messageContent(msg.message);
      for (const block of content) {
        if (block.type === "tool_result") {
          this.emit({
            kind: "tool-result",
            id: str(block.tool_use_id) ?? "",
            content: toolResultText(block.content),
            isError: block.is_error === true,
          });
        }
      }
      return;
    }

    if (type === "result") {
      this.emit({
        kind: "result",
        isError: msg.is_error === true || str(msg.subtype) !== "success",
        costUsd: num(msg.total_cost_usd),
        durationMs: num(msg.duration_ms),
        numTurns: num(msg.num_turns),
        text: str(msg.result),
      });
      return;
    }
  }
}

/** Content blocks of an assistant/user message, tolerant of missing shapes. */
function messageContent(message: unknown): Array<Record<string, unknown>> {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Record<string, unknown> => !!b && typeof b === "object",
  );
}

/** Flatten a tool_result `content` (string or array of text blocks) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
