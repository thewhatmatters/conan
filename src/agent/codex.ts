import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { AgentTurn } from "./attachments.js";
import { loginShellPath } from "../doctor/claude.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentEvent,
  AgentLaunchOpts,
  PermissionDecision,
} from "./driver.js";

/**
 * Codex headless driver (T3-1 US-004) — the structurally-alien provider that
 * proves the AgentDriver seam.
 *
 * Unlike Claude's one long-lived stream-json process per session, `codex exec`
 * is ONE PROCESS PER TURN:
 *
 *   codex exec --json --skip-git-repo-check -C <cwd> --sandbox <policy> \
 *        [-m <model>] [resume <thread_id>] "<prompt>"
 *
 * The first turn spawns fresh and `thread.started` reports the `thread_id`
 * that keys the conversation server-side; every later turn spawns
 * `… resume <thread_id> "<prompt>"` (2-turn context retention verified live,
 * fixture `fixtures/codex-turn2-resume.jsonl`). Two verified footguns
 * (`fixtures/README.md`):
 *   - stdin: `codex exec` reads piped stdin as EXTRA prompt input and an
 *     open-but-silent pipe hangs the turn — the prompt MUST be an argv
 *     argument and the child spawns with stdin `"ignore"`.
 *   - flag order: global flags go BEFORE the `resume` subcommand; `-C` after
 *     `resume` is `error: unexpected argument` (exit 2).
 *
 * stdout is JSONL thread events, parsed by `CodexStreamParser` into the
 * normalized union: `thread.started` → system (sessionId = thread_id),
 * `item.completed(agent_message)` → whole assistant-text (codex has NO token
 * deltas), command/file items → tool-use/tool-result, `turn.completed` →
 * result (token usage, `costUsd` null — codex never reports USD). Unknown
 * event/item types are ignored, never thrown, so a CLI version bump can't
 * crash the parser.
 *
 * Permissions are a SANDBOX POLICY fixed at each spawn — there is no approval
 * channel in `codex exec` (US-001 verified), so `respondPermission()` is an
 * explicit no-op and Supervised-style approval is never offered for codex
 * threads. No live control channel either, but because every turn is a fresh
 * process a mode change genuinely applies from the NEXT turn's spawn — that's
 * `setPermissionMode()`'s honest per-turn semantics here.
 *
 * Interrupt: with no control channel, killing the turn's process IS the
 * interrupt — surfaced honestly as an `exit` event. The thread survives
 * server-side (the resume key is kept), so the next `send()` resumes the same
 * conversation.
 */

/** Codex's verified headless capabilities (codex-cli 0.144.6, US-001 probe
 *  matrix in `fixtures/README.md`): whole items only (no deltas), no approval
 *  channel — permissions are a sandbox policy fixed at spawn — token counts
 *  but never USD, reasoning counted but never streamed as text. Resume
 *  verified via the `codex exec … resume <thread_id>` subcommand. */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  streamingDeltas: false,
  interactiveApproval: false,
  livePermissionSwitch: false,
  costUsd: false,
  reasoningText: false,
  resume: true,
  contextWindowTokens: null,
  // No model picker in Conan; codex reports no model at all.
  modelSelection: false,
  permissionModes: [
    {
      id: "read-only",
      label: "Read only",
      description: "Sandbox: read files only — no writes or state changes",
    },
    {
      id: "workspace-write",
      label: "Workspace write",
      description: "Sandbox: writes allowed inside the workspace",
    },
    {
      id: "danger-full-access",
      label: "Full access",
      description: "No sandbox — every command runs unrestricted",
    },
  ],
  effortModes: [
    { id: "low", label: "Low", description: "Faster responses with less reasoning" },
    { id: "medium", label: "Medium", description: "Balanced reasoning effort" },
    { id: "high", label: "High", description: "More thorough reasoning" },
  ],
};

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Map a permission-mode id onto codex's `--sandbox` policy. Accepts codex's
 *  own vocabulary (the capability descriptor's ids, what the UI sends from
 *  US-009 on) AND Claude's, so a thread launched from today's Claude-vocab
 *  frames still lands on a sensible sandbox. Unknown → read-only, the safe
 *  floor — never a silent full-access default. */
export function sandboxFor(mode: string | undefined): CodexSandbox {
  switch (mode) {
    case "workspace-write":
    case "acceptEdits":
      return "workspace-write";
    case "danger-full-access":
    case "bypassPermissions":
      return "danger-full-access";
    default:
      // read-only / default / plan / undefined / anything unrecognized.
      return "read-only";
  }
}

/** Argv for one turn. Pinned by tests: global flags BEFORE the `resume`
 *  subcommand, the prompt as the LAST argument (never stdin) — both verified
 *  footguns (`fixtures/README.md`). */
export function buildCodexArgs(turn: {
  cwd: string;
  sandbox: CodexSandbox;
  threadId: string | null;
  model?: string;
  effort?: string;
  prompt: string;
}): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    turn.cwd,
    "--sandbox",
    turn.sandbox,
  ];
  if (turn.model) args.push("-m", turn.model);
  if (turn.effort && CODEX_EFFORTS.has(turn.effort)) {
    args.push("-c", `model_reasoning_effort=${turn.effort}`);
  }
  if (turn.threadId) args.push("resume", turn.threadId);
  args.push(turn.prompt);
  return args;
}

export class CodexDriver implements AgentDriver {
  readonly provider = "codex";
  readonly capabilities = CODEX_CAPABILITIES;
  /** The in-flight TURN's process — null between turns (one process per turn,
   *  unlike ClaudeDriver's session-long child). */
  private child: ChildProcess | null = null;
  private disposed = false;
  private opts: AgentLaunchOpts = {};
  /** The conversation's resume key, from `thread.started`. Survives across
   *  turn processes — losing it would orphan the server-side context. */
  private threadId: string | null = null;
  /** The sandbox-mode id the NEXT spawn maps through `sandboxFor()`. Updated
   *  by `setPermissionMode()` and by later prompts' own mode — per-turn
   *  switching is real on codex because every turn is a fresh process. */
  private mode: string | undefined;
  /** The current turn produced a closing event (result/error) — gates the
   *  exit handler so a clean turn end never ALSO emits `exit`. */
  private turnClosed = false;
  /** Resolves when the current turn's process has fully exited. `result` is
   *  emitted BEFORE the process exits, so a next-turn send() can race the
   *  wind-down — it must wait here, not silently drop the prompt. */
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private readonly emit: (e: AgentEvent) => void,
    /** Fallback cwd when the first prompt carries none — evaluated at spawn
     *  time so it tracks the gateway's live active cwd. */
    private readonly fallbackCwd: () => string | null,
  ) {}

  async send(turn: AgentTurn, opts: AgentLaunchOpts): Promise<void> {
    if (this.disposed) return;
    if (this.child) {
      // A turn's process is still up. Genuinely mid-turn → drop (the composer
      // is disabled while busy). Turn already closed → the process is just
      // winding down after its result frame; wait it out, then spawn.
      if (!this.turnClosed) return;
      await this.exited;
    }
    if (!this.threadId) {
      this.opts = opts; // first prompt fixes the launch config
      this.mode = opts.permissionMode;
      if (opts.resume) this.threadId = opts.resume; // reopen a saved thread
    } else if (opts.permissionMode) {
      this.mode = opts.permissionMode; // honest per-turn switch (fresh process)
    }
    await this.spawnTurn(turn.text);
  }

  interrupt(): void {
    // No control channel to cancel gracefully — killing the turn's process IS
    // the interrupt, surfaced honestly as an `exit` event by the exit handler.
    // The thread survives server-side; the next send() resumes it.
    if (!this.child) return;
    this.child.kill("SIGTERM");
  }

  respondPermission(_id: string, _decision: PermissionDecision): void {
    // Explicit no-op: `codex exec` has NO interactive approval channel
    // (capabilities.interactiveApproval false — US-001 verified). Permissions
    // are a sandbox policy fixed per spawn, so no permission-request event is
    // ever emitted and nothing can legitimately arrive here. Documented
    // rather than silently swallowed so the seam stays honest.
  }

  setPermissionMode(mode: string): void {
    // No live process to switch (livePermissionSwitch false) — but each turn
    // is a fresh spawn, so the change GENUINELY applies from the next turn.
    // Confirm it; the UI explains the next-turn timing (US-009).
    this.mode = mode;
    this.emit({ kind: "permission-mode", mode });
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  private async spawnTurn(prompt: string): Promise<void> {
    // Login-shell PATH, same packaged-app gotcha as ClaudeDriver: a
    // Finder-launched bundle never sources ~/.zshrc, so ~/.local/bin (where
    // codex actually lives) is missing from a naive PATH.
    const shellPath = await loginShellPath();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (shellPath) env.PATH = shellPath;
    const bin = process.env.CONAN_CODEX_BIN || "codex";
    const cwd = this.opts.cwd ?? this.fallbackCwd() ?? process.cwd();
    const sandbox = sandboxFor(this.mode);
    const args = buildCodexArgs({
      cwd,
      sandbox,
      threadId: this.threadId,
      model: this.opts.model,
      effort: this.opts.effort,
      prompt,
    });
    // Fresh parser per turn — its state (tool ids, last message) is per-turn
    // anyway, and the system event needs this turn's cwd/sandbox.
    const parser = new CodexStreamParser({ cwd, sandbox });
    const startedAt = Date.now();

    let child: ChildProcess;
    try {
      // stdin "ignore" is load-bearing: codex reads a piped stdin as extra
      // prompt input, and an open-but-silent pipe hangs the turn (verified).
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.emit({ kind: "error", message: (err as Error).message });
      return;
    }
    this.child = child;
    this.turnClosed = false;

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      for (const e of parser.push(line)) {
        if (e.kind === "system" && e.sessionId) this.threadId = e.sessionId;
        if (e.kind === "result") {
          this.turnClosed = true;
          this.emit({ ...e, durationMs: Date.now() - startedAt });
        } else {
          this.emit(e);
        }
      }
    });
    // stderr is diagnostics only; log a bounded slice rather than parse it.
    child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.warn(`[agent] codex stderr: ${s.slice(0, 400)}`);
    });
    this.exited = new Promise<void>((resolve) => {
      child.on("error", (err) => {
        // Spawn-level failure (e.g. ENOENT) — "exit" may never fire after this.
        this.child = null;
        resolve();
        if (this.turnClosed) return;
        this.turnClosed = true;
        this.emit({ kind: "error", message: err.message });
      });
      child.on("exit", (code) => {
        this.child = null;
        resolve();
        if (this.disposed || this.turnClosed) return;
        // The process died without a turn.completed — an interrupt kill or a
        // CLI crash. Surface it honestly; the thread is still resumable.
        this.emit({ kind: "exit", code });
      });
    });
  }
}

/**
 * Stateful JSONL-line → `AgentEvent[]` parser for `codex exec --json`, split
 * out of the driver so it's unit-testable against the US-001 fixtures without
 * spawning a real codex. One parser per TURN (codex is one process per turn).
 *
 * Observed event types (codex-cli 0.144.6, `fixtures/README.md`):
 * `thread.started` / `turn.started` / `item.started` / `item.completed` /
 * `turn.completed`. Everything else — including item types beyond
 * agent_message / command_execution / file_change — is ignored, never thrown.
 */
export class CodexStreamParser {
  /** The resume key from `thread.started` — read by the driver after push. */
  threadId: string | null = null;
  /** item ids already surfaced as tool-use, so a completed item without an
   *  observed `item.started` still gets its opening card. */
  private readonly toolUseSeen = new Set<string>();
  /** Last agent_message of the turn — becomes the result event's text,
   *  mirroring Claude's closing `result.result` string. */
  private lastMessage: string | null = null;

  constructor(
    private readonly ctx: { cwd: string | null; sandbox: string },
  ) {}

  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return []; // ignore non-JSON noise
    }

    switch (msg.type) {
      case "thread.started": {
        this.threadId = str(msg.thread_id);
        return [
          {
            kind: "system",
            sessionId: this.threadId,
            model: null, // codex never reports the resolved model in-stream
            cwd: this.ctx.cwd,
            tools: [],
            permissionMode: this.ctx.sandbox,
          },
        ];
      }

      case "item.started": {
        const item = record(msg.item);
        if (!item) return [];
        return this.toolUse(item);
      }

      case "item.completed": {
        const item = record(msg.item);
        if (!item) return [];
        const id = str(item.id) ?? "";
        if (item.type === "agent_message" && typeof item.text === "string") {
          this.lastMessage = item.text;
          // Whole block, never a delta — codex has no token streaming.
          return item.text.trim() ? [{ kind: "assistant-text", text: item.text }] : [];
        }
        if (item.type === "command_execution") {
          const out: AgentEvent[] = this.toolUseSeen.has(id) ? [] : this.toolUse(item);
          const exitCode = num(item.exit_code);
          out.push({
            kind: "tool-result",
            id,
            content: str(item.aggregated_output) ?? "",
            isError: (exitCode !== null && exitCode !== 0) || item.status === "failed",
          });
          return out;
        }
        if (item.type === "file_change") {
          const out: AgentEvent[] = this.toolUseSeen.has(id) ? [] : this.toolUse(item);
          out.push({
            kind: "tool-result",
            id,
            content: changesSummary(item.changes),
            isError: item.status === "failed",
          });
          return out;
        }
        return []; // unknown item type — a newer CLI, not an error
      }

      case "turn.completed": {
        const usage = record(msg.usage);
        const input = usage ? num(usage.input_tokens) : null;
        const cachedInput = usage ? num(usage.cached_input_tokens) : null;
        return [
          {
            kind: "result",
            isError: false,
            costUsd: null, // codex reports tokens only, never USD (verified)
            durationMs: null, // the driver stamps wall time on emit
            numTurns: null,
            text: this.lastMessage,
            contextTokens: sumReported(input, cachedInput),
            tokens: {
              input,
              cachedInput,
              output: usage ? num(usage.output_tokens) : null,
              reasoningOutput: usage ? num(usage.reasoning_output_tokens) : null,
            },
          },
        ];
      }

      case "turn.failed": {
        // Not observed on 0.144.6 but documented in codex's JSONL schema —
        // close the turn honestly instead of leaving it to the exit handler.
        const error = record(msg.error);
        return [
          {
            kind: "result",
            isError: true,
            costUsd: null,
            durationMs: null,
            numTurns: null,
            text: (error ? str(error.message) : null) ?? this.lastMessage,
            contextTokens: null,
          },
        ];
      }

      default:
        return []; // thread.started dupes, turn.started, future event types
    }
  }

  /** A command/file item's opening tool-use card. */
  private toolUse(item: Record<string, unknown>): AgentEvent[] {
    const id = str(item.id) ?? "";
    if (item.type === "command_execution") {
      this.toolUseSeen.add(id);
      return [
        {
          kind: "tool-use",
          id,
          name: "Command",
          // Keyed `command` so shared approval/detail helpers that look for
          // a command target keep working across providers.
          input: { command: str(item.command) ?? "" },
        },
      ];
    }
    if (item.type === "file_change") {
      this.toolUseSeen.add(id);
      return [
        {
          kind: "tool-use",
          id,
          name: "FileChange",
          input: { changes: item.changes ?? [] },
        },
      ];
    }
    return []; // agent_message never starts; unknown item types ignored
  }
}

/** "add /path/to/file" per change line, for the tool card's result block. */
function changesSummary(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  return changes
    .map((c) => {
      const r = record(c);
      if (!r) return "";
      return [str(r.kind), str(r.path)].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("\n");
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function sumReported(...values: Array<number | null>): number | null {
  return values.every((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
const CODEX_EFFORTS = new Set(["low", "medium", "high"]);
