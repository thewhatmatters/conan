import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "../lib/gateway.ts";
import type { AgentCapabilities } from "./useProviders.ts";

/**
 * Level-2 chat spike — the UI half of the headless-agent driver.
 *
 * Opens a plain WebSocket to the gateway's `/ws/agent` (the programmatic peer
 * of `/ws/terminal`). One connection === one headless `claude -p` process ===
 * one chat session, so we deliberately DON'T use ResilientSocket: an
 * auto-reconnect would silently spawn a new process and lose the conversation.
 * "New chat" is an explicit reconnect.
 *
 * The gateway's normalized `AgentEvent`s are folded into a flat, render-ready
 * `ChatItem[]` transcript (tool results merge into their tool-use card by id).
 */

/** Launch config chosen in the composer chips (mirrors AgentLaunchOpts). */
export interface AgentOpts {
  model?: string;
  /** One of the driver's `capabilities.permissionModes` ids, in the
   *  provider's OWN vocabulary (US-009) — Claude's `default`/`plan`/…,
   *  codex's `read-only`/`workspace-write`/…. Drivers floor unknown ids to
   *  their safest mode. */
  permissionMode?: string;
  effort?: string;
  /** Working directory for the session — the FIRST prompt's cwd fixes it
   *  (US-001); omitted → the gateway's active cwd. */
  cwd?: string;
  /** Sidebar project this thread belongs to (US-014). Consumed by the WS
   *  handler to persist the chat_thread row — never reaches the driver. */
  projectId?: string;
  /** Past session id to resume (US-015) — the driver launches with
   *  `--resume` so the conversation context is restored server-side. */
  resume?: string;
  /** Agent provider a FRESH session launches on (T3-1 US-008: the composer's
   *  provider chip — 'claude' | 'codex' | 'grok'). Absent → claude. On a
   *  resume the gateway relaunches the thread's SAVED provider regardless. */
  provider?: string;
}

export interface OutgoingFileAttachment {
  type: "file";
  path: string;
  content: string;
  /** Set by the composer when the read hit its cap — surfaced in the
   *  transcript so a partial pin never looks complete. */
  truncated?: boolean;
  keep?: boolean;
}

/** A pasted image headed to the gateway's image-staging (US image-paste). The
 *  browser sends base64 + media type; the gateway (prepareImageAttachments)
 *  validates, bounds, and writes the temp file each provider needs. */
export interface OutgoingImage {
  mediaType: string;
  /** Raw base64 (no data: prefix). */
  data: string;
}

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

/** Coarse tool classification mirrored from src/agent/driver.ts. */
// Re-exported from the gateway's driver seam rather than hand-copied. That
// seam is an import-free pure-types module, so this crosses the separate
// tsconfig/build and is erased at build time — but the compiler now connects
// the two programs, making drift a type error instead of a silent gap. This
// file previously mirrored the event union by hand and silently dropped
// `contextTokens` when the drivers started reporting it.
export type {
  ToolPermissionKind,
  PermissionDecision,
} from "../../../src/agent/driver.ts";
import type {
  AgentEvent,
  ToolPermissionKind,
  PermissionDecision,
} from "../../../src/agent/driver.ts";


/** A Supervised-mode permission request awaiting the user's decision.
 *  `toolUseId` pins the request to its transcript tool card — the plan card's
 *  proceed buttons (US-022) act on the approval gating that very card. */
export interface PendingApproval {
  id: string;
  toolKind: ToolPermissionKind;
  summary: string;
  detail: string;
  toolName: string;
  toolUseId: string | null;
}

// AgentEvent is imported from the driver seam above — no local mirror.

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
export type ChatItem =
  | { id: string; role: "user"; text: string; pins?: SentPin[]; images?: SentImage[] }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "reasoning"; text: string }
  | { id: string; role: "tool"; name: string; input: unknown; result: string | null; isError: boolean }
  | { id: string; role: "approval"; requestId: string; toolKind: ToolPermissionKind; toolName: string; summary: string; resolution: ApprovalResolution }
  | { id: string; role: "result"; costUsd: number | null; durationMs: number | null; numTurns: number | null; tokens: TurnTokens | null }
  | { id: string; role: "system"; model: string | null; cwd: string | null }
  | { id: string; role: "mode"; mode: string }
  | { id: string; role: "error"; message: string };

export type ChatStatus = "connecting" | "open" | "closed";

export interface AgentChat {
  items: ChatItem[];
  /** Latest context-window POSITION (input + cached tokens) the provider
   *  reported — NOT what the turn cost. Null until a turn reports one, and
   *  null for providers that report no usage, so the meter stays absent
   *  rather than showing a fabricated zero. */
  contextTokens: number | null;
  busy: boolean;
  status: ChatStatus;
  /** The real Claude session id, from the system init event. Survives across
   *  turns (the process is long-lived); updates if the session respawns. */
  sessionId: string | null;
  /** The oldest unanswered Supervised-mode permission request, or null —
   *  the one the composer's approval panel shows. Cleared by
   *  respondToApproval or by the turn ending (result/exit/error). */
  pendingApproval: PendingApproval | null;
  /** All unanswered requests, oldest first (the panel's 1/N counter). The
   *  driver blocks the turn per request, so this rarely exceeds one — but
   *  the queue keeps the UI honest if it ever pipelines. */
  pendingApprovals: PendingApproval[];
  /** Answer a pending permission request. */
  respondToApproval: (id: string, decision: PermissionDecision) => void;
  /** Submit a user turn (no-op while busy or disconnected). */
  send: (
    text: string,
    opts: AgentOpts,
    attachments?: OutgoingFileAttachment[],
    images?: OutgoingImage[],
  ) => void;
  /** Stop the in-flight turn (graceful interrupt — the session survives). */
  interrupt: () => void;
  /** The session's LIVE permission mode — the launch mode from the init
   *  event, updated by mid-session switches (US-022). Null before launch:
   *  the composer chip's selection still owns the mode then. */
  permissionMode: string | null;
  /** Switch the live session's permission mode (the plan card's "Proceed in
   *  build"). Confirmation comes back as a permission-mode event; failure
   *  surfaces as an error item and the mode stays. */
  setPermissionMode: (mode: string) => void;
  /** The session driver's verified capability descriptor — the
   *  `{type:"capabilities"}` frame the gateway sends once when the first
   *  prompt builds the driver (US-007). Null until then; the pane falls back
   *  to the registry's per-provider descriptor from `useProviders`. */
  capabilities: AgentCapabilities | null;
}

export function useAgentChat(token: string | null): AgentChat {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [permissionMode, setPermissionModeState] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);

  const [contextTokens, setContextTokens] = useState<number | null>(null);
  // Latest context-window POSITION (input + cached) reported by the provider —
  // distinct from what a turn COST. Null until a turn reports it, and null for
  // providers that report no usage, so the meter can stay absent rather than
  // showing a fabricated zero.
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const seq = useRef(0);
  const nextId = () => `i${++seq.current}`;
  // Last session id an init frame reported — a repeat init with the SAME id
  // is a mid-session permission-mode re-init (US-022), not a new session, so
  // the transcript skips a second "Session started" line for it.
  const lastInitSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(`/ws/agent?token=${token}`));
    wsRef.current = ws;
    ws.onopen = () => setStatus("open");
    ws.onclose = () => {
      // A remote close (gateway restart, network drop) ends the session for
      // good — there's deliberately no auto-reconnect. Reset the turn state
      // (a mid-turn drop would otherwise leave `busy` stuck forever) and say
      // so in the transcript. Local closes (unmount) null this handler first.
      setStatus("closed");
      setBusy(false);
      setPendingApprovals([]);
      setItems((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "error",
          message: "Connection to the agent lost — this chat can't continue. Start a new chat.",
        },
      ]);
    };
    ws.onerror = () => setStatus("closed");
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "busy") {
        setBusy(msg.busy === true);
      } else if (msg.type === "capabilities") {
        // Sent once when the driver is built — what THIS session's provider
        // can actually do (US-007/US-009). The permission chip and approval
        // UI adapt to it without ever branching on a provider name.
        setCapabilities((msg.capabilities as AgentCapabilities) ?? null);
      } else if (msg.type === "error") {
        setItems((prev) => [
          ...prev,
          { id: nextId(), role: "error", message: String(msg.message ?? "error") },
        ]);
      } else if (msg.type === "event") {
        applyEvent(msg.event as AgentEvent);
      }
    };
    return () => {
      // Null the handlers before closing: this is a LOCAL teardown (unmount /
      // token change), not a lost connection — the onclose transcript notice
      // must not fire for it.
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** Fold one normalized event into the flat transcript. */
  const applyEvent = useCallback((e: AgentEvent) => {
    // Session-level state rides alongside the transcript fold.
    if (e.kind === "system") {
      setSessionId(e.sessionId);
      if (e.permissionMode) setPermissionModeState(e.permissionMode);
    } else if (e.kind === "permission-mode") {
      setPermissionModeState(e.mode);
    } else if (e.kind === "permission-request") {
      setPendingApprovals((prev) => [
        ...prev,
        { id: e.id, toolKind: e.toolKind, summary: e.summary, detail: e.detail, toolName: e.toolName, toolUseId: e.toolUseId },
      ]);
    } else if (e.kind === "result" || e.kind === "exit" || e.kind === "error") {
      // The turn is over — any unanswered request was settled driver-side.
      setPendingApprovals([]);
    }
    setItems((prev) => {
      switch (e.kind) {
        case "permission-request":
          // The request also reads in the transcript — appended pending,
          // resolved in place by respondToApproval or dismissed at turn end.
          return [
            ...prev,
            {
              id: `ap-${e.id}`,
              role: "approval",
              requestId: e.id,
              toolKind: e.toolKind,
              toolName: e.toolName,
              summary: e.summary,
              resolution: "pending",
            },
          ];
        case "result":
        case "exit":
        case "error": {
          if (e.kind === "result" && e.contextTokens != null) {
            setContextTokens(e.contextTokens);
          }
          // Turn over — mark any still-pending approval entries dismissed
          // before appending the terminal item below.
          const settled = prev.map((it) =>
            it.role === "approval" && it.resolution === "pending"
              ? { ...it, resolution: "dismissed" as const }
              : it,
          );
          if (e.kind === "result")
            return [
              ...settled,
              { id: nextId(), role: "result", costUsd: e.costUsd, durationMs: e.durationMs, numTurns: e.numTurns, tokens: e.tokens ?? null },
            ];
          if (e.kind === "exit")
            return [
              ...settled,
              { id: nextId(), role: "error", message: `Session ended${e.code != null ? ` (exit ${e.code})` : ""}.` },
            ];
          return [...settled, { id: nextId(), role: "error", message: e.message }];
        }
        case "system": {
          // A re-init with the same session id follows a mid-session mode
          // switch — the mode line already told the story; a NEW id is a real
          // (re)start and keeps its "Session started" line.
          if (e.sessionId && e.sessionId === lastInitSessionRef.current) return prev;
          lastInitSessionRef.current = e.sessionId;
          return [...prev, { id: nextId(), role: "system", model: e.model, cwd: e.cwd }];
        }
        case "permission-mode":
          return [...prev, { id: nextId(), role: "mode", mode: e.mode }];
        case "assistant-text":
        case "reasoning": {
          // Deltas append to the open item of the same role in place; a
          // whole block (or a delta after a different item) starts a new one.
          // The driver never emits both for the same content, so appending
          // whenever the last item matches is safe.
          const role = e.kind === "reasoning" ? "reasoning" : "assistant";
          const last = prev[prev.length - 1];
          if (e.delta && last && last.role === role) {
            const next = prev.slice();
            next[next.length - 1] = { ...last, text: last.text + e.text };
            return next;
          }
          return [...prev, { id: nextId(), role, text: e.text }];
        }
        case "tool-use":
          return [
            ...prev,
            { id: e.id || nextId(), role: "tool", name: e.name, input: e.input, result: null, isError: false },
          ];
        case "tool-result": {
          // Merge into the matching tool-use card by id; append if unseen.
          const idx = prev.findIndex((it) => it.role === "tool" && it.id === e.id);
          if (idx === -1) return prev;
          const next = prev.slice();
          const card = next[idx] as Extract<ChatItem, { role: "tool" }>;
          next[idx] = { ...card, result: e.content, isError: e.isError };
          return next;
        }
        default:
          return prev;
      }
    });
  }, []);

  const send = useCallback(
    (
      text: string,
      opts: AgentOpts,
      attachments: OutgoingFileAttachment[] = [],
      images: OutgoingImage[] = [],
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN || busy || !text.trim()) return;
      const pins: SentPin[] = attachments.map((a) => ({
        path: a.path,
        bytes: new TextEncoder().encode(a.content).length,
        truncated: a.truncated === true,
      }));
      const sentImages: SentImage[] = images.map((i) => ({
        dataUrl: `data:${i.mediaType};base64,${i.data}`,
      }));
      setItems((prev) => [
        ...prev,
        {
          id: nextId(),
          role: "user",
          text,
          ...(pins.length ? { pins } : {}),
          ...(sentImages.length ? { images: sentImages } : {}),
        },
      ]);
      ws.send(JSON.stringify({ type: "prompt", text, attachments, images, ...opts }));
    },
    [busy],
  );

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const setPermissionMode = useCallback(
    (mode: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN) return;
      // No optimistic update — the driver confirms with a permission-mode
      // event (or surfaces an error), so the indicator never lies.
      ws.send(JSON.stringify({ type: "set-permission-mode", mode }));
    },
    [],
  );

  const respondToApproval = useCallback((id: string, decision: PermissionDecision) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "permission-response", id, decision }));
    // Clear optimistically — the driver ignores unknown/settled ids, and a
    // fresh request would arrive as its own permission-request event.
    setPendingApprovals((prev) => prev.filter((p) => p.id !== id));
    // Resolve the transcript entry with the decision taken.
    setItems((prev) =>
      prev.map((it) =>
        it.role === "approval" && it.requestId === id && it.resolution === "pending"
          ? { ...it, resolution: decision }
          : it,
      ),
    );
  }, []);

  return {
    items,
    contextTokens,
    busy,
    status,
    sessionId,
    pendingApproval: pendingApprovals[0] ?? null,
    pendingApprovals,
    respondToApproval,
    send,
    interrupt,
    permissionMode,
    setPermissionMode,
    capabilities,
  };
}
