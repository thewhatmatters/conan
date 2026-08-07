/**
 * Chat session reducer — the pure transcript fold.
 *
 * The whole session's client-side state (transcript, busy flag, approval
 * queue, capabilities, context position) lives in one `ChatSessionState`,
 * advanced exclusively by `reduceChat(state, action)`. Every transition that
 * used to hide inside `useAgentChat`'s socket callbacks is an action here —
 * server frames and local intents alike — so the fold is deterministic and
 * table-testable: the same action stream always yields the same transcript,
 * byte for byte.
 *
 * Determinism rules:
 *  - No `Date.now()` — timestamps ride on the action (`now`), stamped by the
 *    adapter at dispatch time.
 *  - No refs/counters outside state — item ids come from `state.seq`, and the
 *    session re-init dedup (`lastInitSessionId`) is state too. That also makes
 *    the reducer safe under StrictMode double-invocation, which the old
 *    ref-mutating updater was not.
 *
 * `useAgentChat` is the React/socket adapter over this module; components
 * never import it directly for state — they consume the hook.
 */
import type {
  AgentCapabilities,
  AgentEvent,
  PermissionDecision,
  ToolPermissionKind,
} from "../../../src/agent/driver.ts";

/** How a sent image renders in the transcript — a data URL for the thumbnail. */
export interface SentImage {
  dataUrl: string;
}

/** A pin as it renders in the transcript — path + size, not the content
 *  (which is in the prompt the agent received). `truncated` when the read hit
 *  its cap, so the transcript never implies the whole file was sent. */
export interface SentPin {
  path: string;
  bytes: number;
  truncated: boolean;
}

/** A Supervised-mode permission request awaiting the user's decision.
 *  `toolUseId` pins the request to its transcript tool card — the plan card's
 *  proceed buttons (US-022) act on the approval gating that very card. */
export interface PendingApproval {
  id: string;
  toolKind: ToolPermissionKind;
  summary: string;
  detail: string;
  /** Raw tool arguments from the event — lets the approval card render an
   *  Edit/Write as a real diff (`buildFileDiff`) instead of only `detail`. */
  input: unknown;
  toolName: string;
  requiresUserInteraction?: boolean;
  toolUseId: string | null;
}

/** How an approval transcript entry ended: still pending, the user's
 *  decision, or dismissed (the turn ended before anyone answered). */
export type ApprovalResolution = "pending" | PermissionDecision | "dismissed";

/** Per-turn token usage, from providers that report counts but no USD
 *  (codex — mirrors the driver's result event, US-010). The footer renders
 *  these when `capabilities.costUsd` is false instead of a blank or
 *  fabricated dollar figure. */
export interface TurnTokens {
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
}

/** A rendered transcript item. */
export type ChatItem = (
  | { id: string; role: "user"; text: string; pins?: SentPin[]; images?: SentImage[] }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "reasoning"; text: string }
  | { id: string; role: "tool"; name: string; input: unknown; result: string | null; isError: boolean }
  | { id: string; role: "approval"; requestId: string; toolKind: ToolPermissionKind; toolName: string; summary: string; resolution: ApprovalResolution }
  | { id: string; role: "result"; costUsd: number | null; durationMs: number | null; numTurns: number | null; tokens: TurnTokens | null }
  | { id: string; role: "system"; model: string | null; cwd: string | null }
  | { id: string; role: "mode"; mode: string }
  | { id: string; role: "error"; message: string }
) & { ts?: number | null };

export type ChatStatus = "connecting" | "open" | "closed";

/** The chat session's entire client-side state — everything `useAgentChat`
 *  exposes (minus the send/respond callbacks, which are adapter concerns). */
export interface ChatSessionState {
  items: ChatItem[];
  /** Latest context-window POSITION (input + cached tokens) the provider
   *  reported — NOT what the turn cost. Null until a turn reports one. */
  contextTokens: number | null;
  busy: boolean;
  status: ChatStatus;
  /** The real session id from the system init event. */
  sessionId: string | null;
  /** The session's LIVE permission mode; null before launch. */
  permissionMode: string | null;
  /** The driver's verified capability descriptor; null until the first
   *  prompt builds the driver. */
  capabilities: AgentCapabilities | null;
  /** Unanswered Supervised-mode requests, oldest first. */
  pendingApprovals: PendingApproval[];
  /** Monotonic item-id counter (`i1`, `i2`, …). In state so id assignment is
   *  deterministic and replay-safe. */
  seq: number;
  /** Last session id an init frame reported — a repeat init with the SAME id
   *  is a mid-session permission-mode re-init (US-022), not a new session, so
   *  the transcript skips a second "Session started" line for it. */
  lastInitSessionId: string | null;
}

export const initialChatState: ChatSessionState = {
  items: [],
  contextTokens: null,
  busy: false,
  status: "connecting",
  sessionId: null,
  permissionMode: null,
  capabilities: null,
  pendingApprovals: [],
  seq: 0,
  lastInitSessionId: null,
};

/** Everything that can advance the session — server frames and local intents,
 *  named honestly rather than local intents masquerading as fake frames.
 *  `now` is the adapter's `Date.now()`; actions without it produce items with
 *  no timestamp (matching the pre-reducer transcript exactly). */
export type ChatAction =
  // ---- server-originated (translated from /ws/agent frames) ----
  | { type: "server-event"; event: AgentEvent; now: number }
  | { type: "busy"; busy: boolean }
  | { type: "capabilities"; capabilities: AgentCapabilities | null }
  | { type: "server-error"; message: string }
  // ---- local intents ----
  | { type: "user-sent"; text: string; pins: SentPin[]; images: SentImage[]; now: number }
  | { type: "approval-responded"; id: string; decision: PermissionDecision }
  | { type: "client-error"; message: string; now: number }
  | { type: "connection-open" }
  | { type: "connection-error" }
  | { type: "connection-lost" };

/** Mark still-pending approval transcript entries dismissed (turn ended). */
function dismissPending(items: ChatItem[]): ChatItem[] {
  return items.map((it) =>
    it.role === "approval" && it.resolution === "pending"
      ? { ...it, resolution: "dismissed" as const }
      : it,
  );
}

export function reduceChat(state: ChatSessionState, action: ChatAction): ChatSessionState {
  // Deterministic id allocation: callers of nextId bump a local copy of the
  // counter; the returned state carries the final value.
  let seq = state.seq;
  const nextId = () => `i${++seq}`;

  switch (action.type) {
    case "busy":
      return { ...state, busy: action.busy };

    case "capabilities":
      return { ...state, capabilities: action.capabilities };

    case "server-error":
      return {
        ...state,
        items: [...state.items, { id: nextId(), role: "error", message: action.message }],
        seq,
      };

    case "user-sent": {
      const { text, pins, images, now } = action;
      return {
        ...state,
        items: [
          ...state.items,
          {
            id: nextId(),
            role: "user",
            text,
            ...(pins.length ? { pins } : {}),
            ...(images.length ? { images } : {}),
            ts: now,
          },
        ],
        seq,
      };
    }

    case "approval-responded":
      // Clear optimistically — the driver ignores unknown/settled ids, and a
      // fresh request would arrive as its own permission-request event.
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((p) => p.id !== action.id),
        items: state.items.map((it) =>
          it.role === "approval" && it.requestId === action.id && it.resolution === "pending"
            ? { ...it, resolution: action.decision }
            : it,
        ),
      };

    case "client-error":
      return {
        ...state,
        items: [...state.items, { id: nextId(), role: "error", message: action.message, ts: action.now }],
        seq,
      };

    case "connection-open":
      return { ...state, status: "open" };

    case "connection-error":
      return { ...state, status: "closed" };

    case "connection-lost":
      // A remote close ends the session for good — there's deliberately no
      // auto-reconnect. Reset the turn state (a mid-turn drop would otherwise
      // leave `busy` stuck forever) and say so in the transcript.
      return {
        ...state,
        status: "closed",
        busy: false,
        pendingApprovals: [],
        items: [
          ...dismissPending(state.items),
          {
            id: nextId(),
            role: "error",
            message: "Connection to the agent lost — this chat can't continue. Start a new chat.",
          },
        ],
        seq,
      };

    case "server-event":
      return reduceEvent(state, action.event, action.now, nextId, () => seq);
  }
}

/** Fold one normalized agent event into the session. */
function reduceEvent(
  state: ChatSessionState,
  e: AgentEvent,
  now: number,
  nextId: () => string,
  seqValue: () => number,
): ChatSessionState {
  switch (e.kind) {
    case "system": {
      const next: ChatSessionState = {
        ...state,
        sessionId: e.sessionId,
        permissionMode: e.permissionMode ? e.permissionMode : state.permissionMode,
      };
      // A re-init with the same session id follows a mid-session mode
      // switch — the mode line already told the story; a NEW id is a real
      // (re)start and keeps its "Session started" line.
      if (e.sessionId && e.sessionId === state.lastInitSessionId) return next;
      return {
        ...next,
        lastInitSessionId: e.sessionId,
        items: [...state.items, { id: nextId(), role: "system", model: e.model, cwd: e.cwd, ts: now }],
        seq: seqValue(),
      };
    }

    case "permission-mode":
      return {
        ...state,
        permissionMode: e.mode,
        items: [...state.items, { id: nextId(), role: "mode", mode: e.mode, ts: now }],
        seq: seqValue(),
      };

    case "permission-request":
      // The request also reads in the transcript — appended pending,
      // resolved in place by approval-responded or dismissed at turn end.
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          { id: e.id, toolKind: e.toolKind, summary: e.summary, detail: e.detail, input: e.input, toolName: e.toolName, ...(e.requiresUserInteraction ? { requiresUserInteraction: true } : {}), toolUseId: e.toolUseId },
        ],
        items: [
          ...state.items,
          {
            id: `ap-${e.id}`,
            role: "approval",
            requestId: e.id,
            toolKind: e.toolKind,
            toolName: e.toolName,
            summary: e.summary,
            resolution: "pending",
            ts: now,
          },
        ],
      };

    case "result":
      return {
        ...state,
        contextTokens: e.contextTokens ?? state.contextTokens,
        pendingApprovals: [],
        items: [
          ...dismissPending(state.items),
          { id: nextId(), role: "result", costUsd: e.costUsd, durationMs: e.durationMs, numTurns: e.numTurns, tokens: e.tokens ?? null, ts: now },
        ],
        seq: seqValue(),
      };

    case "exit":
      return {
        ...state,
        pendingApprovals: [],
        items: [
          ...dismissPending(state.items),
          { id: nextId(), role: "error", message: `Session ended${e.code != null ? ` (exit ${e.code})` : ""}.`, ts: now },
        ],
        seq: seqValue(),
      };

    case "error":
      return {
        ...state,
        pendingApprovals: [],
        items: [...dismissPending(state.items), { id: nextId(), role: "error", message: e.message, ts: now }],
        seq: seqValue(),
      };

    case "assistant-text":
    case "reasoning": {
      // Deltas append to the open item of the same role in place; a whole
      // block (or a delta after a different item) starts a new one. The
      // driver never emits both for the same content, so appending whenever
      // the last item matches is safe.
      const role = e.kind === "reasoning" ? "reasoning" : "assistant";
      const last = state.items[state.items.length - 1];
      if (e.delta && last && last.role === role) {
        const items = state.items.slice();
        items[items.length - 1] = { ...last, text: last.text + e.text };
        return { ...state, items };
      }
      return {
        ...state,
        items: [...state.items, { id: nextId(), role, text: e.text, ts: now }],
        seq: seqValue(),
      };
    }

    case "tool-use":
      return {
        ...state,
        items: [
          ...state.items,
          { id: e.id || nextId(), role: "tool", name: e.name, input: e.input, result: null, isError: false, ts: now },
        ],
        seq: seqValue(),
      };

    case "tool-result": {
      // Merge into the matching tool-use card by id; drop if unseen.
      const idx = state.items.findIndex((it) => it.role === "tool" && it.id === e.id);
      if (idx === -1) return state;
      const items = state.items.slice();
      const card = items[idx] as Extract<ChatItem, { role: "tool" }>;
      items[idx] = { ...card, result: e.content, isError: e.isError };
      return { ...state, items };
    }

    default:
      return state;
  }
}
