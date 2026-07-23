/**
 * Level-2 chat spike — the agent-driver seam.
 *
 * Conan's terminal surface *wraps* the interactive `claude` TUI in a pty. This
 * module is the other interaction model: driving a coding agent **headlessly**
 * (no TUI) and rendering a custom transcript, exactly like t3-code. A composer
 * builds a launch config (model, permission mode) and each turn is a
 * programmatic invocation whose stdout we parse into normalized events.
 *
 * `AgentDriver` is the provider seam. There is one implementation today
 * (`ClaudeDriver`, `./claude.ts`), but Codex/Cursor/OpenCode would each be a
 * driver behind this same interface — a future provider slots in without the
 * WS handler (`./index.ts`) or the UI changing. That is the whole point of
 * defining the interface now even for a single impl.
 */

/** Per-session launch configuration, chosen in the composer's chips. Fixed at
 *  the first prompt — a headless agent keeps conversation context in one live
 *  process, so switching model/permission mid-session isn't meaningful; a new
 *  chat = a new process = a fresh config. */
export interface AgentLaunchOpts {
  /** `--model` value: an alias (`opus`/`sonnet`/`haiku`) or a full model id.
   *  Omitted → the agent's own default model. */
  model?: string;
  /** `--permission-mode`: how tool calls are authorized in headless mode.
   *   - `plan`              — read-only exploration; ends with a proposed plan.
   *   - `acceptEdits`       — auto-approve file edits (Bash etc. may still stall).
   *   - `bypassPermissions` — run every tool without prompting ("Full access").
   *   - `default`           — normal prompting (stalls headless; unused here). */
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /** Working directory the agent process launches in — the project this chat
   *  operates on. Like the rest of the launch config, fixed at the first
   *  prompt. Omitted → the gateway's active cwd (no pty supplies one here). */
  cwd?: string;
}

/**
 * A normalized agent event — the driver's job is to hide each provider's raw
 * wire shape (Claude's stream-json NDJSON here) behind this union so the WS
 * handler and the UI never parse provider-specific JSON.
 */
export type AgentEvent =
  | {
      /** Session bootstrap — the agent reports its resolved id/model/cwd/tools. */
      kind: "system";
      sessionId: string | null;
      model: string | null;
      cwd: string | null;
      tools: string[];
    }
  | {
      /** Assistant prose. With `--include-partial-messages` these arrive as
       *  incremental deltas (`delta: true`) to append to the open block; a
       *  whole completed block (no `delta`) is the fallback when the CLI
       *  emits no partial events. Never both for the same content — the
       *  driver suppresses whole blocks it already streamed. */
      kind: "assistant-text";
      text: string;
      delta?: boolean;
    }
  | {
      /** Thinking/reasoning content, distinct from assistant-text so the UI
       *  can render it collapsed. Same delta/whole-block semantics. */
      kind: "reasoning";
      text: string;
      delta?: boolean;
    }
  | {
      /** The agent invoked a tool. `input` is the raw tool arguments object. */
      kind: "tool-use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      /** A tool finished; correlate to its `tool-use` by `id`. */
      kind: "tool-result";
      id: string;
      content: string;
      isError: boolean;
    }
  | {
      /** Turn complete — the agent is idle and ready for the next prompt. */
      kind: "result";
      isError: boolean;
      costUsd: number | null;
      durationMs: number | null;
      numTurns: number | null;
      text: string | null;
    }
  | {
      /** The underlying process exited (chat session ended). */
      kind: "exit";
      code: number | null;
    }
  | {
      /** A driver-level failure (spawn failed, unparseable stream, etc.). */
      kind: "error";
      message: string;
    };

/**
 * A headless coding-agent session. Lazily spawns its process on the first
 * `send()` (so the composer's launch config applies), then keeps that process
 * alive across turns — subsequent `send()`s continue the same conversation.
 */
export interface AgentDriver {
  /** Stable provider tag (`"claude"`), for logging/UI labeling. */
  readonly provider: string;
  /** Submit a user turn. Spawns the process on first call using `opts`. */
  send(text: string, opts: AgentLaunchOpts): Promise<void>;
  /** Cancel the in-flight turn, keeping the session alive — the provider's
   *  control channel aborts the turn and the process stays ready for the next
   *  `send()`. When the provider can't cancel gracefully the driver falls back
   *  to killing the process, surfaced honestly as an `exit` event (never a
   *  silent pretend-survival). No-op while idle. */
  interrupt(): void;
  /** Tear down the process and release resources (WS close / shutdown). */
  dispose(): void;
}
