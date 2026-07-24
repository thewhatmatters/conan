import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { loginShellPath } from "../doctor/claude.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentEvent,
  AgentLaunchOpts,
  PermissionDecision,
} from "./driver.js";

/**
 * Grok headless driver (T3-1 US-005) — the Claude-like provider: real token
 * deltas AND (unlike Claude's D2 redaction) real readable reasoning text.
 *
 * Like codex, grok is ONE PROCESS PER TURN:
 *
 *   grok -p "<prompt>" --output-format streaming-json --cwd <cwd> \
 *        --permission-mode <mode> [-m <model>] [--resume <sessionId>]
 *
 * The stream is minimal — ONLY three event types were ever observed
 * (grok 0.2.111, `fixtures/README.md`): `{type:"thought",data}` reasoning
 * deltas, `{type:"text",data}` assistant-text deltas, and a closing
 * `{type:"end"}` carrying the sessionId (the resume key), usage, num_turns,
 * and `total_cost_usd`. Tools run INVISIBLY — no tool events exist in the
 * stream (verified: a file-write turn emitted only thought/text/end while the
 * file really appeared on disk). Because the sessionId arrives only at `end`,
 * the parser emits the normalized `system` event right before `result` —
 * later than Claude's up-front init, but the WS handler's thread upsert keys
 * off the same event either way. Unknown event types are ignored, never
 * thrown, so a CLI version bump can't crash the parser.
 *
 * Permissions: `--permission-mode` fixed at each spawn. US-001's probed
 * answers to both open questions shape the seam here:
 *   (a) NO headless interactive approval — in `default` mode a tool needing
 *       approval just ends the turn with `stopReason:"Cancelled"` (fixture
 *       `grok-approval-default.jsonl`), so `respondPermission()` is an
 *       explicit no-op and a Cancelled end is surfaced as an error result
 *       with an honest explanation, never a silent empty turn.
 *   (b) NO live switch (no stdin control channel exists) — but every turn is
 *       a fresh process and `--permission-mode` may differ on a `--resume`
 *       turn (verified: the session cancelled in (a) resumed under
 *       `bypassPermissions` and completed), so `setPermissionMode()` has the
 *       same honest next-turn semantics as codex.
 *
 * Interrupt: no control channel — killing the turn's process IS the
 * interrupt, surfaced as an `exit` event. The session survives server-side;
 * the next `send()` resumes it by the saved sessionId.
 */

/** Grok's verified headless capabilities (grok 0.2.111, US-001 probe matrix
 *  in `fixtures/README.md`): real `thought`/`text` deltas (readable reasoning
 *  — unlike Claude's D2 redaction) and `total_cost_usd`, but NO approval
 *  channel (a tool needing approval cancels the turn — open question (a)) and
 *  no live mode switch (no stdin control channel; per-turn `--permission-mode`
 *  on resume verified instead — open question (b)). */
export const GROK_CAPABILITIES: AgentCapabilities = {
  streamingDeltas: true,
  interactiveApproval: false,
  livePermissionSwitch: false,
  costUsd: true,
  reasoningText: true,
  resume: true,
  contextWindowTokens: null,
  // Grok reports an internal build name (grok-4.5-build) that `-m` rejects.
  modelSelection: false,
  permissionModes: [
    {
      id: "plan",
      label: "Plan",
      description: "Read-only — ends with a proposed plan",
    },
    {
      id: "default",
      label: "Default",
      description: "Tools needing approval cancel the turn — grok has no headless approval",
    },
    {
      id: "acceptEdits",
      label: "Accept edits",
      description: "Auto-approves file edits",
    },
    {
      id: "bypassPermissions",
      label: "Full access",
      description: "Runs every tool without prompting",
    },
  ],
};

/** Grok's own `--permission-mode` vocabulary (grok 0.2.111 --help). */
const GROK_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);

/** Map a permission-mode id onto grok's `--permission-mode`. Grok happens to
 *  share Claude's vocabulary (default/acceptEdits/plan/bypassPermissions) so
 *  known ids pass through verbatim (including grok-only auto/dontAsk).
 *  Unknown → `default`, the most restrictive headless behavior — never a
 *  silent bypass. */
export function grokModeFor(mode: string | undefined): string {
  return mode && GROK_MODES.has(mode) ? mode : "default";
}

/** Argv for one turn. Pinned by tests: the prompt rides `-p` as an argv
 *  argument (stdin stays ignored), `--resume <sessionId>` carries continuity
 *  (2-turn context retention verified, fixture `grok-turn2-resume.jsonl`). */
export function buildGrokArgs(turn: {
  cwd: string;
  mode: string;
  sessionId: string | null;
  model?: string;
  prompt: string;
}): string[] {
  const args = [
    "-p",
    turn.prompt,
    "--output-format",
    "streaming-json",
    "--cwd",
    turn.cwd,
    "--permission-mode",
    turn.mode,
  ];
  if (turn.model) args.push("-m", turn.model);
  if (turn.sessionId) args.push("--resume", turn.sessionId);
  return args;
}

export class GrokDriver implements AgentDriver {
  readonly provider = "grok";
  readonly capabilities = GROK_CAPABILITIES;
  /** The in-flight TURN's process — null between turns (one process per turn,
   *  same shape as CodexDriver). */
  private child: ChildProcess | null = null;
  private disposed = false;
  private opts: AgentLaunchOpts = {};
  /** The conversation's resume key, from the `end` event's sessionId. */
  private sessionId: string | null = null;
  /** The `--permission-mode` the NEXT spawn uses. Updated by
   *  `setPermissionMode()` and by later prompts' own mode — per-turn
   *  switching is real on grok (US-001 open question (b), verified). */
  private mode: string | undefined;
  /** The current turn produced a closing event (result/error) — gates the
   *  exit handler so a clean turn end never ALSO emits `exit`. */
  private turnClosed = false;
  /** Resolves when the current turn's process has fully exited, so a
   *  next-turn send() can't race the wind-down after the result frame. */
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private readonly emit: (e: AgentEvent) => void,
    /** Fallback cwd when the first prompt carries none — evaluated at spawn
     *  time so it tracks the gateway's live active cwd. */
    private readonly fallbackCwd: () => string | null,
  ) {}

  async send(text: string, opts: AgentLaunchOpts): Promise<void> {
    if (this.disposed) return;
    if (this.child) {
      // Genuinely mid-turn → drop (the composer is disabled while busy).
      // Turn already closed → the process is winding down after its end
      // frame; wait it out, then spawn.
      if (!this.turnClosed) return;
      await this.exited;
    }
    if (!this.sessionId) {
      this.opts = opts; // first prompt fixes the launch config
      this.mode = opts.permissionMode;
      if (opts.resume) this.sessionId = opts.resume; // reopen a saved thread
    } else if (opts.permissionMode) {
      this.mode = opts.permissionMode; // honest per-turn switch (fresh process)
    }
    await this.spawnTurn(text);
  }

  interrupt(): void {
    // No control channel to cancel gracefully — killing the turn's process IS
    // the interrupt, surfaced honestly as an `exit` event by the exit handler.
    // The session survives server-side; the next send() resumes it.
    if (!this.child) return;
    this.child.kill("SIGTERM");
  }

  respondPermission(_id: string, _decision: PermissionDecision): void {
    // Explicit no-op: headless grok has NO approval channel (US-001 open
    // question (a) — a tool needing approval ends the turn Cancelled; nothing
    // ever waits on stdin). No permission-request event is ever emitted, so
    // nothing can legitimately arrive here. Documented rather than silently
    // swallowed so the seam stays honest.
  }

  setPermissionMode(mode: string): void {
    // No live process to switch (livePermissionSwitch false) — but each turn
    // is a fresh spawn and per-turn --permission-mode on resume is verified,
    // so the change GENUINELY applies from the next turn. Confirm it; the UI
    // explains the next-turn timing (US-009).
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
    // Login-shell PATH, same packaged-app gotcha as the other drivers: a
    // Finder-launched bundle never sources ~/.zshrc, so ~/.local/bin (where
    // grok actually lives) is missing from a naive PATH.
    const shellPath = await loginShellPath();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (shellPath) env.PATH = shellPath;
    const bin = process.env.CONAN_GROK_BIN || "grok";
    const cwd = this.opts.cwd ?? this.fallbackCwd() ?? process.cwd();
    const mode = grokModeFor(this.mode);
    const args = buildGrokArgs({
      cwd,
      mode,
      sessionId: this.sessionId,
      model: this.opts.model,
      prompt,
    });
    // Fresh parser per turn — its accumulated text is per-turn anyway, and
    // the system event needs this turn's cwd/mode.
    const parser = new GrokStreamParser({ cwd, mode });
    const startedAt = Date.now();

    let child: ChildProcess;
    try {
      // stdin "ignore": the prompt is argv (-p) and nothing ever reads stdin
      // headlessly (US-001 verified — no control channel exists).
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
        if (e.kind === "system" && e.sessionId) this.sessionId = e.sessionId;
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
      if (s) console.warn(`[agent] grok stderr: ${s.slice(0, 400)}`);
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
        // The process died without an end event — an interrupt kill or a CLI
        // crash. Surface it honestly; the session is still resumable.
        this.emit({ kind: "exit", code });
      });
    });
  }
}

/**
 * Stateful JSONL-line → `AgentEvent[]` parser for `grok -p --output-format
 * streaming-json`, split out of the driver so it's unit-testable against the
 * US-001 fixtures without spawning a real grok. One parser per TURN.
 *
 * Observed event types (grok 0.2.111, `fixtures/README.md`): `thought`,
 * `text`, `end` — nothing else, ever (tools run invisibly). Everything
 * unrecognized is ignored, never thrown.
 */
export class GrokStreamParser {
  /** The resume key from `end.sessionId` — read by the driver after push. */
  sessionId: string | null = null;
  /** Accumulated assistant text — becomes the result event's text, mirroring
   *  the other drivers' closing message string. */
  private text = "";

  constructor(private readonly ctx: { cwd: string | null; mode: string }) {}

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
      case "thought": {
        // Real readable reasoning text — grok's headline capability over
        // Claude's D2 redaction. Streamed as deltas the UI appends.
        const data = str(msg.data);
        return data ? [{ kind: "reasoning", text: data, delta: true }] : [];
      }

      case "text": {
        const data = str(msg.data);
        if (!data) return [];
        this.text += data;
        return [{ kind: "assistant-text", text: data, delta: true }];
      }

      case "end": {
        // The one closing frame: sessionId (learned only HERE — grok has no
        // up-front init event), usage, num_turns, total_cost_usd. Emit the
        // normalized system event first so the WS handler's thread upsert
        // sees the sessionId before the turn closes.
        this.sessionId = str(msg.sessionId);
        const stopReason = str(msg.stopReason);
        const cancelled = stopReason !== null && stopReason !== "EndTurn";
        const usage = record(msg.usage);
        const input = usage ? num(usage.input_tokens) : null;
        const cachedInput = usage ? num(usage.cache_read_input_tokens) : null;
        return [
          {
            kind: "system",
            sessionId: this.sessionId,
            model: firstModel(msg.modelUsage),
            cwd: this.ctx.cwd,
            tools: [], // grok never reports a tool list in-stream
            permissionMode: this.ctx.mode,
          },
          {
            kind: "result",
            isError: cancelled,
            // Float field, verified: total_cost_usd_ticks is the same value
            // ×10^10 — use the float (`fixtures/README.md`).
            costUsd: num(msg.total_cost_usd),
            durationMs: null, // the driver stamps wall time on emit
            numTurns: num(msg.num_turns),
            contextTokens: sumReported(input, cachedInput),
            tokens: {
              input,
              cachedInput,
              output: usage ? num(usage.output_tokens) : null,
              reasoningOutput: usage ? num(usage.reasoning_tokens) : null,
            },
            text: this.text
              ? this.text
              : cancelled
                ? `Turn ${stopReason}: grok has no headless tool approval — a tool call needing approval cancels the turn. Retry in a broader permission mode.`
                : null,
          },
        ];
      }

      default:
        return []; // future event types — a newer CLI, not an error
    }
  }
}

/** First model name in `end.modelUsage` — grok's only in-stream model report. */
function firstModel(v: unknown): string | null {
  const r = record(v);
  if (!r) return null;
  const keys = Object.keys(r);
  return keys[0] ?? null;
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
