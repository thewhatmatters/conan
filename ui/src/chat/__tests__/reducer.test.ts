/**
 * Table-driven tests for the chat session reducer — the pure transcript fold.
 *
 * These pin the behaviour `useAgentChat` had before the extraction: the same
 * action stream must always produce the same state, byte for byte (ids and
 * timestamps included — `now` rides on the action, ids come from state.seq).
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../../src/agent/driver.ts";
import {
  initialChatState,
  reduceChat,
  type ChatAction,
  type ChatSessionState,
} from "../reducer.ts";

const T = 1_700_000_000_000;

function run(actions: ChatAction[], from: ChatSessionState = initialChatState): ChatSessionState {
  return actions.reduce(reduceChat, from);
}

function ev(event: AgentEvent, now = T): ChatAction {
  return { type: "server-event", event, now };
}

const initEvent: AgentEvent = {
  kind: "system",
  sessionId: "s-1",
  model: "claude-opus-5",
  cwd: "/repo",
  tools: [],
  permissionMode: "default",
};

describe("system / session bootstrap", () => {
  it("appends a session item and records id + mode", () => {
    const s = run([ev(initEvent)]);
    expect(s.sessionId).toBe("s-1");
    expect(s.permissionMode).toBe("default");
    expect(s.lastInitSessionId).toBe("s-1");
    expect(s.items).toEqual([
      { id: "i1", role: "system", model: "claude-opus-5", cwd: "/repo", ts: T },
    ]);
  });

  it("dedupes a re-init with the SAME session id (mid-session mode switch) but still tracks state", () => {
    const s = run([
      ev(initEvent),
      ev({ ...initEvent, permissionMode: "acceptEdits" }),
    ]);
    expect(s.items).toHaveLength(1); // no second "Session started" line
    expect(s.permissionMode).toBe("acceptEdits"); // session state still advanced
  });

  it("a NEW session id gets its own session item", () => {
    const s = run([ev(initEvent), ev({ ...initEvent, sessionId: "s-2" })]);
    expect(s.items.filter((i) => i.role === "system")).toHaveLength(2);
    expect(s.sessionId).toBe("s-2");
  });

  it("a null permissionMode on re-init keeps the previous mode", () => {
    const s = run([ev(initEvent), ev({ ...initEvent, permissionMode: null })]);
    expect(s.permissionMode).toBe("default");
  });
});

describe("assistant-text / reasoning streaming", () => {
  it("whole blocks each get their own item", () => {
    const s = run([
      ev({ kind: "assistant-text", text: "one" }),
      ev({ kind: "assistant-text", text: "two" }),
    ]);
    expect(s.items).toEqual([
      { id: "i1", role: "assistant", text: "one", ts: T },
      { id: "i2", role: "assistant", text: "two", ts: T },
    ]);
  });

  it("deltas append to the open item of the same role in place", () => {
    const s = run([
      ev({ kind: "assistant-text", text: "Hel", delta: true }),
      ev({ kind: "assistant-text", text: "lo", delta: true }),
    ]);
    expect(s.items).toEqual([{ id: "i1", role: "assistant", text: "Hello", ts: T }]);
  });

  it("a delta after a different role starts a new item", () => {
    const s = run([
      ev({ kind: "reasoning", text: "hmm", delta: true }),
      ev({ kind: "assistant-text", text: "Hi", delta: true }),
    ]);
    expect(s.items.map((i) => i.role)).toEqual(["reasoning", "assistant"]);
  });

  it("reasoning deltas coalesce independently of assistant text", () => {
    const s = run([
      ev({ kind: "reasoning", text: "a", delta: true }),
      ev({ kind: "reasoning", text: "b", delta: true }),
    ]);
    expect(s.items).toEqual([{ id: "i1", role: "reasoning", text: "ab", ts: T }]);
  });
});

describe("tool cards", () => {
  it("tool-use appends a card keyed by the event id; tool-result merges into it", () => {
    const s = run([
      ev({ kind: "tool-use", id: "tu-1", name: "Read", input: { path: "a.ts" } }),
      ev({ kind: "tool-result", id: "tu-1", content: "file body", isError: false }),
    ]);
    expect(s.items).toEqual([
      { id: "tu-1", role: "tool", name: "Read", input: { path: "a.ts" }, result: "file body", isError: false, ts: T },
    ]);
  });

  it("an unmatched tool-result changes nothing", () => {
    const before = run([ev({ kind: "assistant-text", text: "x" })]);
    const after = reduceChat(before, ev({ kind: "tool-result", id: "nope", content: "y", isError: true }));
    expect(after).toBe(before); // identity — no items rebuilt
  });

  it("an error tool-result marks the card", () => {
    const s = run([
      ev({ kind: "tool-use", id: "tu-2", name: "Bash", input: {} }),
      ev({ kind: "tool-result", id: "tu-2", content: "boom", isError: true }),
    ]);
    expect(s.items[0]).toMatchObject({ role: "tool", result: "boom", isError: true });
  });
});

const request: AgentEvent = {
  kind: "permission-request",
  id: "req-1",
  toolKind: "command",
  summary: "Run tests",
  detail: "npm test",
  input: { command: "npm test" },
  toolName: "Bash",
  toolUseId: "tu-9",
};

describe("approval lifecycle", () => {
  it("permission-request queues the approval and appends a pending transcript entry", () => {
    const s = run([ev(request)]);
    expect(s.pendingApprovals).toEqual([
      { id: "req-1", toolKind: "command", summary: "Run tests", detail: "npm test", input: { command: "npm test" }, toolName: "Bash", toolUseId: "tu-9" },
    ]);
    expect(s.items).toEqual([
      { id: "ap-req-1", role: "approval", requestId: "req-1", toolKind: "command", toolName: "Bash", summary: "Run tests", resolution: "pending", ts: T },
    ]);
  });

  it("approval-responded clears the queue and resolves the entry with the decision", () => {
    const s = run([ev(request), { type: "approval-responded", id: "req-1", decision: "acceptForSession" }]);
    expect(s.pendingApprovals).toEqual([]);
    expect(s.items[0]).toMatchObject({ role: "approval", resolution: "acceptForSession" });
  });

  it("turn end dismisses unanswered approvals (result, exit, and error alike)", () => {
    for (const terminal of [
      { kind: "result", isError: false, costUsd: null, durationMs: null, numTurns: null, text: null, contextTokens: null } as AgentEvent,
      { kind: "exit", code: 0 } as AgentEvent,
      { kind: "error", message: "spawn failed" } as AgentEvent,
    ]) {
      const s = run([ev(request), ev(terminal)]);
      expect(s.pendingApprovals).toEqual([]);
      expect(s.items[0]).toMatchObject({ role: "approval", resolution: "dismissed" });
    }
  });

  it("an already-resolved entry is not re-dismissed at turn end", () => {
    const s = run([
      ev(request),
      { type: "approval-responded", id: "req-1", decision: "decline" },
      ev({ kind: "exit", code: null }),
    ]);
    expect(s.items[0]).toMatchObject({ resolution: "decline" });
  });
});

describe("turn results and errors", () => {
  it("result appends a footer item and records the context position", () => {
    const s = run([
      ev({
        kind: "result", isError: false, costUsd: 0.12, durationMs: 3400, numTurns: 2, text: null,
        contextTokens: 45_000,
        tokens: { input: 100, cachedInput: 50, output: 20, reasoningOutput: null },
      }),
    ]);
    expect(s.contextTokens).toBe(45_000);
    expect(s.items).toEqual([
      { id: "i1", role: "result", costUsd: 0.12, durationMs: 3400, numTurns: 2, tokens: { input: 100, cachedInput: 50, output: 20, reasoningOutput: null }, ts: T },
    ]);
  });

  it("a result with null contextTokens keeps the previous position", () => {
    const s = run([
      ev({ kind: "result", isError: false, costUsd: null, durationMs: null, numTurns: null, text: null, contextTokens: 9000 }),
      ev({ kind: "result", isError: false, costUsd: null, durationMs: null, numTurns: null, text: null, contextTokens: null }),
    ]);
    expect(s.contextTokens).toBe(9000);
  });

  it("a result without a tokens payload stores null tokens", () => {
    const s = run([ev({ kind: "result", isError: false, costUsd: 1, durationMs: 1, numTurns: 1, text: null, contextTokens: null })]);
    expect(s.items[0]).toMatchObject({ role: "result", tokens: null });
  });

  it("exit renders its code; a null code renders bare", () => {
    const withCode = run([ev({ kind: "exit", code: 1 })]);
    expect(withCode.items[0]).toMatchObject({ role: "error", message: "Session ended (exit 1)." });
    const bare = run([ev({ kind: "exit", code: null })]);
    expect(bare.items[0]).toMatchObject({ role: "error", message: "Session ended." });
  });

  it("driver errors land in the transcript", () => {
    const s = run([ev({ kind: "error", message: "unparseable stream" })]);
    expect(s.items[0]).toMatchObject({ role: "error", message: "unparseable stream" });
  });

  it("permission-mode changes append a mode line and update the live mode", () => {
    const s = run([ev(initEvent), ev({ kind: "permission-mode", mode: "plan" })]);
    expect(s.permissionMode).toBe("plan");
    expect(s.items[1]).toEqual({ id: "i2", role: "mode", mode: "plan", ts: T });
  });
});

describe("local intents and connection lifecycle", () => {
  it("user-sent appends the prompt; empty pins/images are omitted entirely", () => {
    const s = run([{ type: "user-sent", text: "hi", pins: [], images: [], now: T }]);
    expect(s.items).toEqual([{ id: "i1", role: "user", text: "hi", ts: T }]);
    const item = s.items[0] ?? {};
    expect("pins" in item).toBe(false);
    expect("images" in item).toBe(false);
  });

  it("user-sent carries pins and image thumbnails when present", () => {
    const s = run([
      {
        type: "user-sent",
        text: "look",
        pins: [{ path: "a.ts", bytes: 12, truncated: false }],
        images: [{ dataUrl: "data:image/png;base64,AA==" }],
        now: T,
      },
    ]);
    expect(s.items[0]).toMatchObject({
      role: "user",
      pins: [{ path: "a.ts", bytes: 12, truncated: false }],
      images: [{ dataUrl: "data:image/png;base64,AA==" }],
    });
  });

  it("server-error and client-error both append error items (client ones timestamped)", () => {
    const s = run([
      { type: "server-error", message: "no such provider" },
      { type: "client-error", message: "worktree failed", now: T },
    ]);
    expect(s.items[0]).toEqual({ id: "i1", role: "error", message: "no such provider" });
    expect(s.items[1]).toEqual({ id: "i2", role: "error", message: "worktree failed", ts: T });
  });

  it("busy and capabilities frames set their fields and touch nothing else", () => {
    const caps = { streamingDeltas: true } as never;
    const s = run([{ type: "busy", busy: true }, { type: "capabilities", capabilities: caps }]);
    expect(s.busy).toBe(true);
    expect(s.capabilities).toBe(caps);
    expect(s.items).toEqual([]);
  });

  it("connection-open/-error move status; connection-lost also resets the turn and says so", () => {
    expect(run([{ type: "connection-open" }]).status).toBe("open");
    expect(run([{ type: "connection-error" }]).status).toBe("closed");
    const s = run([
      { type: "connection-open" },
      { type: "busy", busy: true },
      ev(request),
      { type: "connection-lost" },
    ]);
    expect(s.status).toBe("closed");
    expect(s.busy).toBe(false);
    expect(s.pendingApprovals).toEqual([]);
    const last = s.items[s.items.length - 1];
    expect(last).toEqual({
      id: "i1",
      role: "error",
      message: "Connection to the agent lost — this chat can't continue. Start a new chat.",
    });
  });
});

describe("determinism", () => {
  const stream: ChatAction[] = [
    { type: "connection-open" },
    { type: "user-sent", text: "go", pins: [], images: [], now: T },
    { type: "busy", busy: true },
    ev(initEvent),
    ev({ kind: "assistant-text", text: "Wor", delta: true }),
    ev({ kind: "assistant-text", text: "king", delta: true }),
    ev({ kind: "tool-use", id: "tu-1", name: "Bash", input: {} }),
    ev({ kind: "tool-result", id: "tu-1", content: "ok", isError: false }),
    ev({ kind: "result", isError: false, costUsd: 0.01, durationMs: 5, numTurns: 1, text: null, contextTokens: 1234 }),
    { type: "busy", busy: false },
  ];

  it("the same action stream yields a deep-equal state, byte for byte", () => {
    expect(run(stream)).toEqual(run(stream));
  });

  it("re-reducing any single action from the same state is idempotent in result (StrictMode safety)", () => {
    // React StrictMode double-invokes reducers: reduce(state, a) is computed
    // twice and one result is kept. Purity means both computations agree —
    // including the session re-init dedup that used to break under a ref.
    let state = initialChatState;
    for (const action of stream) {
      const once = reduceChat(state, action);
      const twice = reduceChat(state, action);
      expect(twice).toEqual(once);
      state = once;
    }
    const roles = state.items.map((i) => i.role);
    expect(roles).toEqual(["user", "system", "assistant", "tool", "result"]);
  });

  it("item ids are allocated from state.seq in order", () => {
    const s = run(stream);
    const ids = s.items.map((i) => i.id);
    expect(ids).toEqual(["i1", "i2", "i3", "tu-1", "i4"]);
    expect(s.seq).toBe(4);
  });
});
