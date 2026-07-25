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
 * Kimi Code headless driver (fourth provider) — Moonshot's `kimi` CLI, an
 * OAuth-subscription agent (no API key). Like codex and grok, ONE PROCESS PER
 * TURN:
 *
 *   kimi -p "<prompt>" --output-format stream-json [-m <model>] [-r <sessionId>]
 *
 * The stream is an OpenAI-flavoured NDJSON of `role`-tagged records (verified
 * against kimi 0.27.0, `fixtures/README.md`):
 *   {"role":"assistant","content":"…"}                         → assistant text
 *   {"role":"assistant","tool_calls":[{id,function:{name,arguments}}]} → tool use
 *   {"role":"tool","tool_call_id":"…","content":"…"}           → tool result
 *   {"role":"meta","type":"session.resume_hint","session_id":…} → the resume key
 *
 * Assistant text arrives as WHOLE messages, not token deltas (streamingDeltas
 * false, like codex). The session id is learned only from the closing
 * `session.resume_hint` meta — so, mirroring grok's `end`, the parser emits the
 * normalized `system` event (with the sessionId) and the `result` event when it
 * sees that meta. Kimi reports NO model in-stream, which is why the WS handler's
 * launch-model persistence (not the reported model) is what keeps resume valid.
 * Unknown records are ignored, never thrown, so a CLI bump can't crash it.
 *
 * ⚠️ Permissions: headless `-p` REJECTS every permission flag
 * (`--auto`/`--yolo`/`--plan` all error with `-p`) and AUTO-EXECUTES tools with
 * no approval step — verified: a Bash tool ran unprompted. There is no headless
 * approval channel, so `interactiveApproval` is false and the single permission
 * mode is an honest "Full access" (reusing codex's `danger-full-access` id so
 * the chip renders it in red). `respondPermission()` is a documented no-op.
 *
 * Interrupt: no control channel — killing the turn's process IS the interrupt,
 * surfaced as `exit`. The session survives server-side; the next `send()`
 * resumes it by the saved id.
 */

/** Kimi's verified headless capabilities (kimi 0.27.0). Whole-message output
 *  (no deltas), no headless approval channel, no in-stream cost or reasoning
 *  text. `image_in` is advertised by the models but the `-p` image WIRE PATH is
 *  not exposed by the CLI, so imageInput stays false until it's verified —
 *  never a dead affordance. */
export const KIMI_CAPABILITIES: AgentCapabilities = {
  imageInput: false,
  streamingDeltas: false,
  interactiveApproval: false,
  livePermissionSwitch: false,
  costUsd: false,
  reasoningText: false,
  resume: true,
  contextWindowTokens: null,
  // Kimi accepts `-m <alias>` (verified `-m kimi-code/k3`); it reports no model
  // in-stream, so the LAUNCH model is persisted, not a reported one.
  modelSelection: true,
  // Verified via `kimi provider list --json` (kimi 0.27.0). null = the config
  // default (`kimi-code/k3`). Context windows in registry.ts CONTEXT_WINDOWS.
  models: [
    { value: null, label: "Default model", description: "K3 · Kimi's default (1M context)" },
    { value: "kimi-code/k3", label: "K3", description: "1M context" },
    { value: "kimi-code/kimi-for-coding", label: "K2.7 Coding", description: "256K context" },
    {
      value: "kimi-code/kimi-for-coding-highspeed",
      label: "K2.7 Coding Highspeed",
      description: "256K context",
    },
  ],
  // Headless kimi auto-approves every tool — a single honest "Full access" mode
  // (the `danger-full-access` id renders red via the UI's DANGER_MODE_IDS). The
  // mode is informational only: `-p` ignores permission flags, so nothing is
  // passed to the spawn and it can't be narrowed.
  permissionModes: [
    {
      id: "danger-full-access",
      label: "Full access",
      description: "Kimi runs every tool without asking — headless mode has no approval step",
    },
  ],
  // No reasoning-effort flag on the CLI.
  effortModes: [],
};

/** Argv for one turn. Pinned by tests: prompt rides `-p` as argv (stdin stays
 *  ignored), `--output-format stream-json` for the NDJSON, `-m <alias>` selects
 *  the model, `-r <sessionId>` resumes (kimi's own resume-hint form; verified to
 *  retain context across turns). No permission flag — `-p` rejects them. */
export function buildKimiArgs(turn: {
  sessionId: string | null;
  model?: string;
  prompt: string;
}): string[] {
  const args = ["-p", turn.prompt, "--output-format", "stream-json"];
  if (turn.model) args.push("-m", turn.model);
  if (turn.sessionId) args.push("-r", turn.sessionId);
  return args;
}

export class KimiDriver implements AgentDriver {
  readonly provider = "kimi";
  readonly capabilities = KIMI_CAPABILITIES;
  /** The in-flight TURN's process — null between turns (one process per turn,
   *  same shape as CodexDriver/GrokDriver). */
  private child: ChildProcess | null = null;
  private disposed = false;
  private opts: AgentLaunchOpts = {};
  /** The conversation's resume key, from the closing resume-hint meta. */
  private sessionId: string | null = null;
  /** The current turn produced a closing event (result/error) — gates the exit
   *  handler so a clean turn end never ALSO emits `exit`. */
  private turnClosed = false;
  /** Resolves when the current turn's process has fully exited, so a next-turn
   *  send() can't race the wind-down after the closing meta. */
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
      // Genuinely mid-turn → drop (composer disabled while busy). Turn already
      // closed → the process is winding down; wait it out, then spawn.
      if (!this.turnClosed) return;
      await this.exited;
    }
    if (!this.sessionId) {
      this.opts = opts; // first prompt fixes the launch config
      if (opts.resume) this.sessionId = opts.resume; // reopen a saved thread
    }
    await this.spawnTurn(turn);
  }

  interrupt(): void {
    // No control channel to cancel gracefully — killing the turn's process IS
    // the interrupt, surfaced honestly as an `exit`. The session survives
    // server-side; the next send() resumes it.
    if (!this.child) return;
    this.child.kill("SIGTERM");
  }

  respondPermission(_id: string, _decision: PermissionDecision): void {
    // Explicit no-op: headless kimi has NO approval channel — `-p` auto-executes
    // tools and rejects every permission flag, so no permission-request event is
    // ever emitted and nothing can legitimately arrive here. Documented rather
    // than silently swallowed so the seam stays honest.
  }

  setPermissionMode(mode: string): void {
    // Kimi's permission mode is informational (headless `-p` ignores it), and
    // there is only one mode — but confirm the pick so the chip stays truthful.
    this.emit({ kind: "permission-mode", mode });
  }

  dispose(): void {
    this.disposed = true;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  private async spawnTurn(turn: AgentTurn): Promise<void> {
    // Login-shell PATH, same packaged-app gotcha as the other drivers: a
    // Finder-launched bundle never sources ~/.zshrc, so ~/.kimi-code/bin (where
    // kimi lives) is missing from a naive PATH.
    const shellPath = await loginShellPath();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (shellPath) env.PATH = shellPath;
    const bin = process.env.CONAN_KIMI_BIN || "kimi";
    const cwd = this.opts.cwd ?? this.fallbackCwd() ?? process.cwd();
    const args = buildKimiArgs({
      sessionId: this.sessionId,
      model: this.opts.model,
      prompt: turn.text,
    });
    // Fresh parser per turn — its accumulated text is per-turn anyway, and the
    // system event needs this turn's cwd.
    const parser = new KimiStreamParser({ cwd });
    const startedAt = Date.now();

    let child: ChildProcess;
    try {
      // stdin "ignore": the prompt is argv (-p) and nothing reads stdin
      // headlessly (no control channel exists).
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
      if (s) console.warn(`[agent] kimi stderr: ${s.slice(0, 400)}`);
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
        // The process died without a closing meta — an interrupt kill or a CLI
        // crash. Surface it honestly; the session is still resumable.
        this.emit({ kind: "exit", code });
      });
    });
  }
}

/**
 * Stateful NDJSON-line → `AgentEvent[]` parser for `kimi -p --output-format
 * stream-json`, split out of the driver so it's unit-testable against the
 * fixtures without spawning a real kimi. One parser per TURN.
 *
 * Records are `role`-tagged (kimi 0.27.0, `fixtures/README.md`):
 *   assistant + content   → assistant-text (whole block)
 *   assistant + tool_calls → one tool-use per call (OpenAI function shape)
 *   tool                  → tool-result (correlated by tool_call_id)
 *   meta session.resume_hint → the closing frame: emit system + result
 * Everything unrecognized is ignored, never thrown.
 */
export class KimiStreamParser {
  /** The resume key from the closing meta — read by the driver after push. */
  sessionId: string | null = null;
  /** Accumulated assistant text — becomes the result event's text, mirroring
   *  the other drivers' closing message string (used as the thread preview). */
  private text = "";

  constructor(private readonly ctx: { cwd: string | null }) {}

  push(line: string): AgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return []; // ignore non-JSON noise
    }

    const role = str(msg.role);

    // Closing frame: the session id is learned ONLY here (no up-front init).
    // Emit the normalized system event first (so the WS handler's thread upsert
    // sees the sessionId) then the result — same ordering as grok's `end`.
    if (role === "meta" && str(msg.type) === "session.resume_hint") {
      this.sessionId = str(msg.session_id);
      return [
        {
          kind: "system",
          sessionId: this.sessionId,
          model: null, // kimi never reports the resolved model in-stream
          cwd: this.ctx.cwd,
          tools: [],
          permissionMode: "danger-full-access",
        },
        {
          kind: "result",
          isError: false,
          costUsd: null, // no cost in the stream (subscription)
          durationMs: null, // the driver stamps wall time on emit
          numTurns: null,
          contextTokens: null, // kimi reports no usage in-stream
          text: this.text || null,
        },
      ];
    }

    if (role === "assistant") {
      const events: AgentEvent[] = [];
      // Tool calls ride the assistant record (OpenAI function shape).
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const call of toolCalls) {
        const c = record(call);
        const fn = c ? record(c.function) : null;
        const id = c ? str(c.id) : null;
        const name = fn ? str(fn.name) : null;
        if (!id || !name) continue;
        events.push({ kind: "tool-use", id, name, input: parseArgs(fn?.arguments) });
      }
      // Assistant prose arrives as a whole message (no deltas).
      const content = str(msg.content);
      if (content) {
        this.text += content;
        events.push({ kind: "assistant-text", text: content });
      }
      return events;
    }

    if (role === "tool") {
      const id = str(msg.tool_call_id);
      const content = str(msg.content) ?? "";
      if (!id) return [];
      return [{ kind: "tool-result", id, content, isError: false }];
    }

    return []; // unknown record — a newer CLI, not an error
  }
}

/** Tool `arguments` is a JSON STRING (OpenAI shape); parse it, falling back to
 *  the raw string so a malformed payload still surfaces in the tool card. */
function parseArgs(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
