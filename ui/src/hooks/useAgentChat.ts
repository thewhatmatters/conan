import { useCallback, useEffect, useReducer, useRef } from "react";
import { wsUrl } from "../lib/gateway.ts";
import type { AgentCapabilities } from "./useProviders.ts";
import {
  initialChatState,
  reduceChat,
  type ChatItem,
  type ChatStatus,
  type PendingApproval,
  type SentImage,
  type SentPin,
} from "../chat/reducer.ts";

/**
 * The React/socket adapter over the chat session reducer
 * (`ui/src/chat/reducer.ts`) — the UI half of the headless-agent driver.
 *
 * Opens a plain WebSocket to the gateway's `/ws/agent` (the programmatic peer
 * of `/ws/terminal`). One connection === one headless `claude -p` process ===
 * one chat session, so we deliberately DON'T use ResilientSocket: an
 * auto-reconnect would silently spawn a new process and lose the conversation.
 * "New chat" is an explicit reconnect.
 *
 * All state transitions live in the pure reducer; this hook only translates
 * socket frames and user calls into `ChatAction`s (stamping `Date.now()` on
 * the ones that timestamp transcript items) and sends the outgoing frames.
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

// The transcript/session types moved to the chat domain (`ui/src/chat/`);
// re-exported here so existing importers keep working unchanged.
export type {
  ApprovalResolution,
  ChatItem,
  ChatStatus,
  PendingApproval,
  SentImage,
  SentPin,
  TurnTokens,
} from "../chat/reducer.ts";

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
import type { AgentEvent, PermissionDecision } from "../../../src/agent/driver.ts";

/** The Browser-surface report frame (WHA-109). Type-imported from the gateway's
 *  own definition — same trick as the driver seam above, so the wire shape
 *  cannot drift between the two programs. Types only: the module is erased at
 *  build time and nothing node-typed enters the UI bundle. */
export type { BrowserSurfaceState as BrowserSurfaceReport } from "../../../src/browser/surface.ts";
import type { BrowserSurfaceState as BrowserSurfaceReport } from "../../../src/browser/surface.ts";

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
  /** Surface a client-side launch/composer failure in the transcript. */
  reportError: (message: string) => void;
  /** Tell the gateway what this thread's Browser surface is showing (WHA-109),
   *  so the next turn can carry an auto-context line naming the page. Ambient
   *  and additive — v1 never calls it, and not calling it changes nothing. */
  reportBrowserSurface: (state: BrowserSurfaceReport) => void;
  /** The session driver's verified capability descriptor — the
   *  `{type:"capabilities"}` frame the gateway sends once when the first
   *  prompt builds the driver (US-007). Null until then; the pane falls back
   *  to the registry's per-provider descriptor from `useProviders`. */
  capabilities: AgentCapabilities | null;
}

export function useAgentChat(token: string | null): AgentChat {
  const [state, dispatch] = useReducer(reduceChat, initialChatState);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(`/ws/agent?token=${token}`));
    wsRef.current = ws;
    ws.onopen = () => dispatch({ type: "connection-open" });
    ws.onclose = () => {
      // A remote close (gateway restart, network drop) ends the session for
      // good. Local closes (unmount) null this handler first, so the
      // reducer's transcript notice never fires for them.
      dispatch({ type: "connection-lost" });
    };
    ws.onerror = () => dispatch({ type: "connection-error" });
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "busy") {
        dispatch({ type: "busy", busy: msg.busy === true });
      } else if (msg.type === "capabilities") {
        // Sent when the driver is built — what THIS session's provider can
        // actually do (US-007/US-009). The permission chip and approval UI
        // adapt to it without ever branching on a provider name.
        dispatch({ type: "capabilities", capabilities: (msg.capabilities as AgentCapabilities) ?? null });
      } else if (msg.type === "error") {
        dispatch({ type: "server-error", message: String(msg.message ?? "error") });
      } else if (msg.type === "event") {
        dispatch({ type: "server-event", event: msg.event as AgentEvent, now: Date.now() });
      }
    };
    return () => {
      // Null the handlers before closing: this is a LOCAL teardown (unmount /
      // token change), not a lost connection — the connection-lost transcript
      // notice must not fire for it.
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    };
  }, [token]);

  const send = useCallback(
    (
      text: string,
      opts: AgentOpts,
      attachments: OutgoingFileAttachment[] = [],
      images: OutgoingImage[] = [],
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN || state.busy || !text.trim()) return;
      const pins: SentPin[] = attachments.map((a) => ({
        path: a.path,
        bytes: new TextEncoder().encode(a.content).length,
        truncated: a.truncated === true,
      }));
      const sentImages: SentImage[] = images.map((i) => ({
        dataUrl: `data:${i.mediaType};base64,${i.data}`,
      }));
      dispatch({ type: "user-sent", text, pins, images: sentImages, now: Date.now() });
      ws.send(JSON.stringify({ type: "prompt", text, attachments, images, ...opts }));
    },
    [state.busy],
  );

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const setPermissionMode = useCallback((mode: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    // No optimistic update — the driver confirms with a permission-mode
    // event (or surfaces an error), so the indicator never lies.
    ws.send(JSON.stringify({ type: "set-permission-mode", mode }));
  }, []);

  const reportError = useCallback((message: string) => {
    dispatch({ type: "client-error", message, now: Date.now() });
  }, []);

  const reportBrowserSurface = useCallback((state: BrowserSurfaceReport) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    // Fire-and-forget: this is ambient context, not a request. Dropping a
    // report while the socket is down costs one turn's browser context, which
    // is strictly better than queueing a URL that may be stale by reconnect.
    ws.send(JSON.stringify({ type: "browser-surface", ...state }));
  }, []);

  const respondToApproval = useCallback((id: string, decision: PermissionDecision) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "permission-response", id, decision }));
    dispatch({ type: "approval-responded", id, decision });
  }, []);

  return {
    items: state.items,
    contextTokens: state.contextTokens,
    busy: state.busy,
    status: state.status,
    sessionId: state.sessionId,
    pendingApproval: state.pendingApprovals[0] ?? null,
    pendingApprovals: state.pendingApprovals,
    respondToApproval,
    send,
    interrupt,
    permissionMode: state.permissionMode,
    setPermissionMode,
    reportError,
    reportBrowserSurface,
    capabilities: state.capabilities,
  };
}
