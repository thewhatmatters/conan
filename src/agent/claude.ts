import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { AgentTurn } from "./attachments.js";
import { cleanupStagedImages } from "./imageStaging.js";
import { detectClaude, loginShellPath } from "../doctor/claude.js";
import type {
  AgentCapabilities,
  AgentDriver,
  AgentEvent,
  AgentLaunchOpts,
  PermissionDecision,
  ToolPermissionKind,
} from "./driver.js";

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
 * Permissions (Supervised mode): spawning with `--permission-prompt-tool
 * stdio` (the Agent SDK's own transport — subscription auth untouched, no
 * ANTHROPIC_API_KEY) makes the CLI route each tool call that permission rules
 * don't already settle to stdout as a `control_request {subtype:
 * "can_use_tool"}` and block the turn until we answer with a
 * `control_response` carrying `{behavior:"allow"}` or `{behavior:"deny",
 * message, interrupt?}`. Deny continues the turn without the tool (the model
 * sees `message` as an error tool_result); `interrupt:true` aborts the whole
 * turn while the session survives — all three verified live on claude
 * 2.1.218. Supervised (`default`/unset) AND plan wire the flag; acceptEdits /
 * bypassPermissions keep today's no-prompt behavior.
 *
 * Plan mode (US-022): headless plan sessions never offer ExitPlanMode
 * WITHOUT the stdio prompt tool (verified on 2.1.218 — the model just writes
 * a plan file and ends). WITH it, ExitPlanMode appears, carries the full plan
 * markdown in `input.plan`, and raises a `can_use_tool` request — approving
 * it exits plan mode CLI-side and the same turn continues straight into
 * build under `default` (Supervised) rules; the driver emits a
 * `permission-mode` event so the UI's indicator follows. Plan mode's own
 * read-only tools and the plans-dir Write are settled CLI-side and never
 * prompt. A `control_request {subtype:"set_permission_mode", mode}` on stdin
 * switches a live session's mode (also verified: success response echoes the
 * mode and the next init frame reports it) — that's `setPermissionMode()`,
 * the "proceed in build" path for an already-settled plan turn.
 *
 * Spike scope remaining: launch config fixed at the first prompt.
 */
/** How long to wait for a `control_response` before concluding the installed
 *  claude has no control channel and falling back to killing the process. */
const INTERRUPT_FALLBACK_MS = 3000;

/** Claude's verified headless capabilities (claude 2.1.218 + the US-001
 *  probe matrix in `fixtures/README.md`). `reasoningText` is FALSE by design:
 *  headless `claude -p` redacts thinking text (empty string + signature only —
 *  D2), so the reasoning UI must stay hidden even though `reasoning` events
 *  exist on the wire. */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  imageInput: true,
  streamingDeltas: true,
  interactiveApproval: true,
  livePermissionSwitch: true,
  costUsd: true,
  reasoningText: false,
  resume: true,
  contextWindowTokens: null,
  // Claude reports a real alias (e.g. claude-fable-5) and offers a model picker.
  modelSelection: true,
  permissionModes: [
    { id: "plan", label: "Plan", description: "Read-only — ends with a proposed plan" },
    { id: "default", label: "Supervised", description: "Asks before running tools" },
    { id: "acceptEdits", label: "Accept edits", description: "Auto-approves file edits" },
    {
      id: "bypassPermissions",
      label: "Full access",
      description: "Runs every tool without prompting",
    },
  ],
  effortModes: [
    { id: "think", label: "Think", description: "Ask Claude to reason carefully" },
    {
      id: "ultrathink",
      label: "Ultrathink",
      description: "Ask Claude to use its deepest available reasoning",
    },
  ],
};

/** Claude's own `--permission-mode` vocabulary. A mode id from another
 *  provider's descriptor (e.g. codex's `read-only` surviving a provider
 *  switch in the composer) floors to `default` — Supervised, the safest
 *  behavior — instead of crashing the CLI with a value it doesn't know.
 *  Mirrors codex's `sandboxFor` / grok's `grokModeFor`. */
const CLAUDE_MODES = new Set(["default", "plan", "acceptEdits", "bypassPermissions"]);

export function claudeModeFor(mode: string | undefined): string {
  return mode && CLAUDE_MODES.has(mode) ? mode : "default";
}

export function claudePromptFor(text: string, effort: string | undefined): string {
  if (effort === "think") return `Think carefully.\n\n${text}`;
  if (effort === "ultrathink") return `Ultrathink before answering.\n\n${text}`;
  return text;
}

/** Exact stream-json user envelope verified against Claude Code 2.1.219. */
export function buildClaudeUserMessage(
  turn: AgentTurn,
  effort: string | undefined,
): {
  type: "user";
  message: {
    role: "user";
    content: Array<
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      | { type: "text"; text: string }
    >;
  };
} {
  const content: Array<
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    | { type: "text"; text: string }
  > = [];
  for (const image of turn.images ?? []) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType,
        data: image.data,
      },
    });
  }
  content.push({ type: "text", text: claudePromptFor(turn.text, effort) });
  return { type: "user", message: { role: "user", content } };
}

export class ClaudeDriver implements AgentDriver {
  readonly provider = "claude";
  readonly capabilities = CLAUDE_CAPABILITIES;
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
  /** In-flight `set_permission_mode` requests by request_id → target mode.
   *  No fallback timer: a lost response just leaves the mode as-is, honestly
   *  reflected by the indicator never changing. */
  private readonly pendingModeSwitches = new Map<string, string>();
  private modeSwitchSeq = 0;
  /** Permission requests awaiting the user's decision, by CLI request_id.
   *  The CLI blocks the turn on each until we write a control_response. */
  private readonly pendingPermissions = new Map<
    string,
    { toolUseId: string | null; input: unknown; toolKind: ToolPermissionKind; toolName: string }
  >();
  /** Tool kinds the user granted "always allow this session" — answered
   *  driver-side without another permission-request event. */
  private readonly sessionApprovedKinds = new Set<ToolPermissionKind>();
  private readonly parser = new ClaudeStreamParser(
    (r) => this.onControlResponse(r),
    (r) => this.onControlRequest(r),
  );

  constructor(
    private readonly emit: (e: AgentEvent) => void,
    /** Fallback cwd when the first prompt carries none — evaluated at spawn
     *  time (not boot) so it tracks the gateway's live active cwd. */
    private readonly fallbackCwd: () => string | null,
  ) {}

  async send(turn: AgentTurn, opts: AgentLaunchOpts): Promise<void> {
    if (this.disposed) return;
    if (!this.child && !this.starting) {
      this.opts = opts; // first prompt fixes the launch config
      this.starting = this.spawnClaude();
    }
    if (this.starting) await this.starting;
    if (!this.child) return; // spawn failed — an `error` event was already emitted
    // stream-json input: one JSON user message per line. The prompt text rides
    // stdin (never an argv), so there is no shell-quoting / injection surface.
    const msg = JSON.stringify(buildClaudeUserMessage(turn, this.opts.effort));
    try {
      this.child.stdin.write(msg + "\n");
    } finally {
      // Claude consumes inline bytes; its staged-path mirror is no longer
      // needed once the complete JSON line has been copied into stdin.
      cleanupStagedImages(turn.images ?? []);
    }
    this.turnActive = true;
  }

  interrupt(): void {
    // Graceful cancel: a control_request on stdin aborts the turn while the
    // process — and the conversation context — survives. The CLI closes the
    // turn with a `result` frame, which flows to the UI like any other.
    if (!this.child || !this.turnActive || this.pendingInterrupt) return;
    if (this.pendingPermissions.size > 0) {
      // The CLI is blocked awaiting our permission answer, not running the
      // turn — a deny with `interrupt:true` IS the graceful cancel there
      // (the CLI closes the turn with its usual `result` frame).
      for (const id of [...this.pendingPermissions.keys()]) {
        this.respondPermission(id, "cancel");
      }
      return;
    }
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
    // Mode-switch answers (US-022): success confirms the CLI is now in the
    // requested mode — surface it so the UI's indicator follows; an error
    // (e.g. an older claude without set_permission_mode) is surfaced honestly
    // and the mode simply stays.
    if (r.requestId && this.pendingModeSwitches.has(r.requestId)) {
      const mode = this.pendingModeSwitches.get(r.requestId)!;
      this.pendingModeSwitches.delete(r.requestId);
      if (r.ok) {
        this.emit({ kind: "permission-mode", mode });
      } else {
        this.emit({
          kind: "error",
          message: `Permission-mode switch failed (${r.error ?? "unsupported by the installed claude"}) — still in the previous mode.`,
        });
      }
      return;
    }
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

  /** A `control_request` FROM the CLI — permission prompts routed to stdio.
   *  Anything else gets an error response so the CLI never hangs on us. */
  private onControlRequest(r: ControlRequest): void {
    if (!r.requestId) return;
    if (r.subtype !== "can_use_tool") {
      this.writeControlResponse(r.requestId, null, `unsupported control request: ${r.subtype ?? "?"}`);
      return;
    }
    const toolName = r.toolName ?? "tool";
    const toolKind = classifyTool(toolName);
    if (this.sessionApprovedKinds.has(toolKind)) {
      this.writeControlResponse(r.requestId, {
        behavior: "allow",
        updatedInput: r.input ?? {},
        ...(r.toolUseId ? { toolUseID: r.toolUseId } : {}),
      });
      return;
    }
    this.pendingPermissions.set(r.requestId, {
      toolUseId: r.toolUseId,
      input: r.input,
      toolKind,
      toolName,
    });
    this.emit({
      kind: "permission-request",
      id: r.requestId,
      toolKind,
      summary: permissionSummary(toolName, r.input, r.description),
      detail: permissionDetail(toolName, r.input),
      toolName,
      toolUseId: r.toolUseId,
    });
  }

  setPermissionMode(rawMode: string): void {
    if (!this.child) return; // pre-launch: the composer chip still owns the mode
    const mode = claudeModeFor(rawMode);
    const id = `spm-${++this.modeSwitchSeq}`;
    this.pendingModeSwitches.set(id, mode);
    this.child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: id,
        request: { subtype: "set_permission_mode", mode },
      }) + "\n",
    );
  }

  respondPermission(id: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return; // already settled, or cleared by a turn ending
    this.pendingPermissions.delete(id);
    const toolUseID = pending.toolUseId ? { toolUseID: pending.toolUseId } : {};
    if (decision === "acceptForSession")
      this.sessionApprovedKinds.add(pending.toolKind);
    if (decision === "accept" || decision === "acceptForSession") {
      this.writeControlResponse(id, {
        behavior: "allow",
        updatedInput: pending.input ?? {},
        ...toolUseID,
      });
      // Approving ExitPlanMode exits plan mode CLI-side and the turn continues
      // under `default` rules (verified live on 2.1.218: the very next tool
      // call prompted). No init frame confirms it mid-turn, so surface the
      // switch here for the UI's mode indicator.
      if (pending.toolName === "ExitPlanMode")
        this.emit({ kind: "permission-mode", mode: "default" });
    } else if (decision === "decline") {
      // The CLI feeds `message` to the model as an error tool_result and the
      // turn continues without the tool (verified live).
      this.writeControlResponse(id, {
        behavior: "deny",
        message: "User declined this tool use.",
        ...toolUseID,
      });
    } else {
      // cancel: interrupt:true aborts the turn; the session survives and the
      // CLI closes with a result frame (verified live).
      this.writeControlResponse(id, {
        behavior: "deny",
        message: "User cancelled the turn.",
        interrupt: true,
        ...toolUseID,
      });
    }
  }

  /** Answer a CLI `control_request` — success with a payload, or an error. */
  private writeControlResponse(
    requestId: string,
    response: Record<string, unknown> | null,
    error?: string,
  ): void {
    if (!this.child) return;
    const envelope = error
      ? { subtype: "error", request_id: requestId, error }
      : { subtype: "success", request_id: requestId, response };
    this.child.stdin.write(
      JSON.stringify({ type: "control_response", response: envelope }) + "\n",
    );
  }

  /** A turn ended (result) or the session died (exit/error) — an interrupt
   *  still pending has nothing left to cancel, so disarm its kill fallback;
   *  permission requests still pending belong to that dead turn, so drop
   *  them (the UI clears its panel on the same result/exit event). */
  private turnSettled(): void {
    this.turnActive = false;
    this.pendingPermissions.clear();
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
    if (this.opts.resume) args.push("--resume", this.opts.resume);
    if (this.opts.permissionMode)
      args.push("--permission-mode", claudeModeFor(this.opts.permissionMode));
    // Permission prompts ride the control channel instead of headless
    // auto-deny (US-004); plan mode needs it too or the CLI never offers
    // ExitPlanMode headlessly (US-022). Wired unconditionally: modes are
    // live-switchable mid-session (chat-v1 polish US-001), so a session
    // launched acceptEdits/bypassPermissions can move into Supervised/Plan
    // later — those modes just never prompt while active. Tools the user's
    // own permission rules already allow are settled CLI-side and never
    // reach us.
    args.push("--permission-prompt-tool", "stdio");
    // Enables bypassPermissions as a mid-session TARGET without enabling it
    // now: the CLI rejects set_permission_mode → bypassPermissions unless
    // launched with the option. The switch itself only ever comes from our
    // control channel behind the UI's one-time Full-access confirm — the
    // model has no tool that can invoke it.
    args.push("--allow-dangerously-skip-permissions");

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

/** A `control_request` FROM the CLI — with `--permission-prompt-tool stdio`
 *  that's a `can_use_tool` permission prompt (shape captured live, claude
 *  2.1.218). Same Claude-internal plumbing: routed to the driver via a
 *  callback, never into the AgentEvent stream. */
export interface ControlRequest {
  requestId: string | null;
  subtype: string | null;
  toolName: string | null;
  input: unknown;
  toolUseId: string | null;
  /** The model's own one-liner for the call (e.g. Bash description). */
  description: string | null;
}

/** Coarse permission grouping for the approval UI + acceptForSession. */
export function classifyTool(name: string): ToolPermissionKind {
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "command";
    case "Read":
    case "Glob":
    case "Grep":
    case "NotebookRead":
      return "file-read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "file-change";
    default:
      return "other";
  }
}

/** One-line human summary for the approval panel header. */
function permissionSummary(
  toolName: string,
  input: unknown,
  description: string | null,
): string {
  if (description) return description;
  const target = inputTarget(input);
  return target ? `${toolName}: ${target}` : `Run ${toolName}`;
}

/** The thing being approved — command / path / raw input — for the panel's
 *  mono block. */
function permissionDetail(toolName: string, input: unknown): string {
  const target = inputTarget(input);
  if (target) return target;
  try {
    return JSON.stringify(input ?? {}, null, 2).slice(0, 2000);
  } catch {
    return String(input);
  }
}

/** The primary target inside a tool input: a Bash command or a file path. */
function inputTarget(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  return str(o.command) ?? str(o.file_path) ?? str(o.path) ?? str(o.pattern);
}

/**
 * Stateful NDJSON-line → `AgentEvent[]` parser, split out of the driver so the
 * streaming/dedup logic is unit-testable without spawning a real `claude`.
 *
 * State: per-message-id, which MODALITIES actually streamed as deltas. A whole
 * `assistant` frame's block is suppressed only if that modality already streamed
 * (tool_use always passes through). Per-modality — not per-message — because the
 * model can stream text as `text_delta`s while emitting its thinking ONLY as a
 * whole-frame block (few/zero `thinking_delta`s): suppressing the whole frame on
 * message_start alone then dropped reasoning entirely (the D2 bug). Cleared at
 * each `result` — every frame of a turn precedes its result.
 */
export class ClaudeStreamParser {
  private streamed = new Map<string, { text: boolean; thinking: boolean }>();
  private currentMessageId: string | null = null;

  /** Record that a modality streamed a delta for the in-flight message. */
  private markStreamed(kind: "text" | "thinking"): void {
    const id = this.currentMessageId;
    if (!id) return;
    let s = this.streamed.get(id);
    if (!s) {
      s = { text: false, thinking: false };
      this.streamed.set(id, s);
    }
    s[kind] = true;
  }

  constructor(
    private readonly onControlResponse?: (r: ControlResponse) => void,
    private readonly onControlRequest?: (r: ControlRequest) => void,
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

    if (type === "control_request") {
      // Shape (captured live, claude 2.1.218, --permission-prompt-tool stdio):
      //   {type:"control_request", request_id, request:{subtype:"can_use_tool",
      //    tool_name, display_name, input, description?,
      //    permission_suggestions?, tool_use_id}}
      const req =
        msg.request && typeof msg.request === "object"
          ? (msg.request as Record<string, unknown>)
          : null;
      this.onControlRequest?.({
        requestId: str(msg.request_id),
        subtype: req ? str(req.subtype) : null,
        toolName: req ? str(req.tool_name) : null,
        input: req ? (req.input ?? null) : null,
        toolUseId: req ? str(req.tool_use_id) : null,
        description: req ? str(req.description) : null,
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
        this.currentMessageId = id;
        if (id && !this.streamed.has(id))
          this.streamed.set(id, { text: false, thinking: false });
        return [];
      }
      if (event.type === "content_block_delta") {
        const delta =
          event.delta && typeof event.delta === "object"
            ? (event.delta as Record<string, unknown>)
            : null;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          this.markStreamed("text");
          return [{ kind: "assistant-text", text: delta.text, delta: true }];
        }
        if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking
        ) {
          this.markStreamed("thinking");
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
          // Re-emitted after a set_permission_mode switch, so this tracks the
          // LIVE mode (field name captured live, claude 2.1.218).
          permissionMode: str(msg.permissionMode),
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
      // Per-modality suppression: a whole-frame block is a duplicate ONLY if
      // that modality actually streamed deltas. Thinking that never streamed
      // (whole-frame only) must still emit — that was the D2 bug.
      const streamed = id != null ? this.streamed.get(id) : undefined;
      const out: AgentEvent[] = [];
      for (const block of messageContent(msg.message)) {
        if (block.type === "text" && typeof block.text === "string") {
          if (!streamed?.text && block.text.trim())
            out.push({ kind: "assistant-text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          if (!streamed?.thinking && block.thinking.trim())
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
      this.streamed.clear();
      this.currentMessageId = null;
      const usage = record(msg.usage);
      const input = usage ? num(usage.input_tokens) : null;
      const cachedInput = usage ? num(usage.cache_read_input_tokens) : null;
      return [
        {
          kind: "result",
          isError: msg.is_error === true || str(msg.subtype) !== "success",
          costUsd: num(msg.total_cost_usd),
          durationMs: num(msg.duration_ms),
          numTurns: num(msg.num_turns),
          text: str(msg.result),
          contextTokens: sumReported(input, cachedInput),
          tokens: {
            input,
            cachedInput,
            output: usage ? num(usage.output_tokens) : null,
            reasoningOutput: null,
          },
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
function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}
function sumReported(...values: Array<number | null>): number | null {
  return values.every((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
