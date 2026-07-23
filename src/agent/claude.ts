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
 * Streaming: `--include-partial-messages` adds `stream_event` frames (the raw
 * Anthropic SSE events) between the whole-message frames — text_delta /
 * thinking_delta become incremental `assistant-text` / `reasoning` deltas.
 * The CLI still emits the aggregate `assistant` frame afterwards (one frame
 * PER content block, all sharing the message id), so the parser tracks which
 * message ids streamed and suppresses their text/thinking blocks to avoid
 * double-render; tool_use blocks only ever ride the whole frames.
 *
 * Interrupt: a `control_request {subtype:"interrupt"}` line on stdin cancels
 * the in-flight turn while the process (and its conversation context)
 * survives — the CLI answers with a `control_response` and closes the turn
 * with a `result {subtype:"error_during_execution"}` frame (verified live on
 * claude 2.1.218; an idle-session interrupt is answered success and does
 * nothing). If no response arrives the driver falls back to killing the
 * process, surfaced honestly as an `exit` event.
 *
 * Spike scope remaining: launch config fixed at the first prompt.
 */
/** How long to wait for a `control_response` before concluding the installed
 *  claude has no control channel and falling back to killing the process. */
const INTERRUPT_FALLBACK_MS = 3000;

export class ClaudeDriver implements AgentDriver {
  readonly provider = "claude";
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private opts: AgentLaunchOpts = {};
  /** A turn is in flight: a prompt was sent and no result/exit/error yet.
   *  Gates interrupt() so Stop on an idle session never touches the process. */
  private turnActive = false;
  /** The one in-flight interrupt request, armed with its fallback timer. */
  private pendingInterrupt: { id: string; timer: NodeJS.Timeout } | null = null;
  private interruptSeq = 0;
  private readonly parser = new ClaudeStreamParser((r) =>
    this.onControlResponse(r),
  );

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
    this.turnActive = true;
  }

  interrupt(): void {
    // Graceful cancel: a control_request on stdin aborts the turn while the
    // process — and the conversation context — survives. The CLI closes the
    // turn with a `result` frame, which flows to the UI like any other.
    if (!this.child || !this.turnActive || this.pendingInterrupt) return;
    const id = `intr-${++this.interruptSeq}`;
    const timer = setTimeout(() => {
      this.pendingInterrupt = null;
      // Only reachable while the turn is still running (a finished turn
      // clears the pending interrupt) — this claude has no working control
      // channel, so surface the downgrade honestly and end the session.
      this.emit({
        kind: "error",
        message:
          "Graceful interrupt unsupported by the installed claude — ending the session.",
      });
      this.child?.kill("SIGTERM");
    }, INTERRUPT_FALLBACK_MS);
    this.pendingInterrupt = { id, timer };
    this.child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: id,
        request: { subtype: "interrupt" },
      }) + "\n",
    );
  }

  private onControlResponse(r: ControlResponse): void {
    if (!this.pendingInterrupt || (r.requestId && r.requestId !== this.pendingInterrupt.id))
      return;
    clearTimeout(this.pendingInterrupt.timer);
    this.pendingInterrupt = null;
    if (!r.ok) {
      // The CLI answered but refused the interrupt — same honest downgrade.
      this.emit({
        kind: "error",
        message: `Interrupt failed (${r.error ?? "unknown error"}) — ending the session.`,
      });
      this.child?.kill("SIGTERM");
    }
    // Success: the CLI aborts the turn and emits its closing `result` frame.
  }

  /** A turn ended (result) or the session died (exit/error) — an interrupt
   *  still pending has nothing left to cancel, so disarm its kill fallback. */
  private turnSettled(): void {
    this.turnActive = false;
    if (this.pendingInterrupt) {
      clearTimeout(this.pendingInterrupt.timer);
      this.pendingInterrupt = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.turnSettled();
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
      "--include-partial-messages",
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
    rl.on("line", (line) => {
      for (const e of this.parser.push(line)) {
        if (e.kind === "result") this.turnSettled();
        this.emit(e);
      }
    });
    // stderr is diagnostics only (job-control notices, model warnings); log a
    // bounded slice rather than parse it.
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.warn(`[agent] claude stderr: ${s.slice(0, 400)}`);
    });
    child.on("error", (err) => {
      this.turnSettled();
      this.emit({ kind: "error", message: err.message });
    });
    child.on("exit", (code) => {
      this.child = null;
      this.turnSettled();
      if (!this.disposed) this.emit({ kind: "exit", code });
    });
  }

}

/** The CLI's answer to a stdin `control_request` (e.g. an interrupt) —
 *  Claude-internal plumbing, not part of the cross-provider AgentEvent seam,
 *  so the parser routes it to the driver via a callback instead. */
export interface ControlResponse {
  requestId: string | null;
  ok: boolean;
  error: string | null;
}

/**
 * Stateful NDJSON-line → `AgentEvent[]` parser, split out of the driver so the
 * streaming/dedup logic is unit-testable without spawning a real `claude`.
 *
 * State: the set of message ids seen as `stream_event` message_starts. A whole
 * `assistant` frame whose id is in the set already streamed its text/thinking
 * as deltas, so those blocks are suppressed (tool_use always passes through).
 * Cleared at each `result` — every frame of a turn precedes its result.
 */
export class ClaudeStreamParser {
  private streamedMessageIds = new Set<string>();

  constructor(
    private readonly onControlResponse?: (r: ControlResponse) => void,
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
    const type = msg.type;

    if (type === "control_response") {
      // Shape (captured live, claude 2.1.218):
      //   {type:"control_response", response:{subtype:"success"|"error",
      //    request_id, response?/error?}}
      const resp =
        msg.response && typeof msg.response === "object"
          ? (msg.response as Record<string, unknown>)
          : null;
      this.onControlResponse?.({
        requestId: resp ? str(resp.request_id) : null,
        ok: resp?.subtype === "success",
        error: resp ? str(resp.error) : null,
      });
      return [];
    }

    if (type === "stream_event") {
      const event =
        msg.event && typeof msg.event === "object"
          ? (msg.event as Record<string, unknown>)
          : null;
      if (!event) return [];
      if (event.type === "message_start") {
        const id =
          event.message && typeof event.message === "object"
            ? str((event.message as Record<string, unknown>).id)
            : null;
        if (id) this.streamedMessageIds.add(id);
        return [];
      }
      if (event.type === "content_block_delta") {
        const delta =
          event.delta && typeof event.delta === "object"
            ? (event.delta as Record<string, unknown>)
            : null;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          return [{ kind: "assistant-text", text: delta.text, delta: true }];
        }
        if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking
        ) {
          return [{ kind: "reasoning", text: delta.thinking, delta: true }];
        }
        return []; // input_json_delta / signature_delta — not rendered
      }
      return []; // content_block_start/stop, message_delta/stop
    }

    if (type === "system" && msg.subtype === "init") {
      return [
        {
          kind: "system",
          sessionId: str(msg.session_id),
          model: str(msg.model),
          cwd: str(msg.cwd),
          tools: Array.isArray(msg.tools)
            ? msg.tools.filter((t): t is string => typeof t === "string")
            : [],
        },
      ];
    }

    if (type === "assistant") {
      // The CLI emits one whole `assistant` frame PER content block, all
      // sharing the message id — so the streamed-id check must hold across
      // multiple frames of the same message.
      const id =
        msg.message && typeof msg.message === "object"
          ? str((msg.message as Record<string, unknown>).id)
          : null;
      const alreadyStreamed = id != null && this.streamedMessageIds.has(id);
      const out: AgentEvent[] = [];
      for (const block of messageContent(msg.message)) {
        if (block.type === "text" && typeof block.text === "string") {
          if (!alreadyStreamed && block.text.trim())
            out.push({ kind: "assistant-text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          if (!alreadyStreamed && block.thinking.trim())
            out.push({ kind: "reasoning", text: block.thinking });
        } else if (block.type === "tool_use") {
          out.push({
            kind: "tool-use",
            id: str(block.id) ?? "",
            name: str(block.name) ?? "tool",
            input: block.input ?? null,
          });
        }
      }
      return out;
    }

    if (type === "user") {
      // Tool results come back as a user message carrying tool_result blocks.
      const out: AgentEvent[] = [];
      for (const block of messageContent(msg.message)) {
        if (block.type === "tool_result") {
          out.push({
            kind: "tool-result",
            id: str(block.tool_use_id) ?? "",
            content: toolResultText(block.content),
            isError: block.is_error === true,
          });
        }
      }
      return out;
    }

    if (type === "result") {
      this.streamedMessageIds.clear();
      return [
        {
          kind: "result",
          isError: msg.is_error === true || str(msg.subtype) !== "success",
          costUsd: num(msg.total_cost_usd),
          durationMs: num(msg.duration_ms),
          numTurns: num(msg.num_turns),
          text: str(msg.result),
        },
      ];
    }

    return [];
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
