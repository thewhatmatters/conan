/**
 * v2 chat data adapter (US-201).
 *
 * Reads one thread's session out of the live registry (`ui/src/chat/
 * sessionStore.ts`) and turns it into the surface `V2ChatView` renders. The
 * transcript fold is still the shared reducer; only the socket's OWNER moved.
 *
 * WHA-105 is why this no longer wraps v1's `useAgentChat`. That hook owns its
 * socket in an effect, so unmounting closes it — and v2 remounts this view on
 * every thread switch, which killed the running agent turn. The session now
 * outlives the view: this hook subscribes to it and drops the subscription on
 * unmount, and nothing else.
 *
 * WHA-97 restored the permission/capabilities pass-throughs the skeleton
 * originally omitted so the v2 composer can follow live mode (and so the
 * context meter in WHA-101 has something to read).
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  getSessionState,
  dispatchToSession,
  sendToSession,
  subscribeToSession,
} from "../../chat/sessionStore.ts";
import { initialChatState, type SentImage, type SentPin } from "../../chat/reducer.ts";
import type {
  AgentOpts,
  ChatItem,
  ChatStatus,
  OutgoingFileAttachment,
  OutgoingImage,
  PendingApproval,
  PermissionDecision,
  BrowserSurfaceReport,
} from "../../hooks/useAgentChat.ts";
import type { AgentCapabilities } from "../../hooks/useProviders.ts";

export interface V2Chat {
  items: ChatItem[];
  send: (
    text: string,
    opts: AgentOpts,
    attachments?: OutgoingFileAttachment[],
    images?: OutgoingImage[],
  ) => void;
  status: ChatStatus;
  busy: boolean;
  awaitingApproval: boolean;
  pendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  respondToApproval: (id: string, decision: PermissionDecision, updatedInput?: unknown) => void;
  /** Stop the in-flight turn — ChatSendButton's stop state needs this. */
  interrupt: () => void;
  /** Latest context-window position, null until a turn reports one. */
  contextTokens: number | null;
  /** Real agent session id from the system init event; null pre-launch. */
  sessionId: string | null;
  /** Live permission mode from the session; null before launch. */
  permissionMode: string | null;
  /** Mid-session permission switch (US-022) — confirmed by permission-mode. */
  setPermissionMode: (mode: string) => void;
  /** Surface a client-side launch/composer failure in the transcript. */
  reportError: (message: string) => void;
  /** Report the Browser surface's live state for the turn's auto-context
   *  block (WHA-109). Ambient — never blocks or acknowledges. */
  reportBrowserSurface: (state: BrowserSurfaceReport) => void;
  /** Session driver capabilities frame; null until first prompt builds it. */
  capabilities: AgentCapabilities | null;
}

const noopUnsubscribe = () => {};

/**
 * @param token    gateway auth token; null until `/api/config` resolves.
 * @param threadKey the shell's selection key — the session's identity in the
 *   registry, and what makes it survive this hook unmounting. Null (no
 *   selection) opens nothing and reports a `connecting` session.
 */
export function useV2Chat(token: string | null, threadKey: string | null): V2Chat {
  const live = token != null && threadKey != null;

  const subscribe = useCallback(
    (listener: () => void) =>
      live ? subscribeToSession(threadKey, token, listener) : noopUnsubscribe,
    [live, threadKey, token],
  );
  const getSnapshot = useCallback(
    () => (live ? getSessionState(threadKey) : initialChatState),
    [live, threadKey],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const send = useCallback(
    (
      text: string,
      opts: AgentOpts,
      attachments: OutgoingFileAttachment[] = [],
      images: OutgoingImage[] = [],
    ) => {
      if (!live || state.busy || !text.trim()) return;
      const pins: SentPin[] = attachments.map((a) => ({
        path: a.path,
        bytes: new TextEncoder().encode(a.content).length,
        truncated: a.truncated === true,
      }));
      const sentImages: SentImage[] = images.map((i) => ({
        dataUrl: `data:${i.mediaType};base64,${i.data}`,
      }));
      // Frame first: a closed socket must not leave an optimistic user bubble
      // above a turn that was never sent.
      if (!sendToSession(threadKey, { type: "prompt", text, attachments, images, ...opts })) {
        return;
      }
      dispatchToSession(threadKey, {
        type: "user-sent",
        text,
        pins,
        images: sentImages,
        now: Date.now(),
      });
    },
    [live, state.busy, threadKey],
  );

  const interrupt = useCallback(() => {
    if (live) sendToSession(threadKey, { type: "interrupt" });
  }, [live, threadKey]);

  const setPermissionMode = useCallback(
    (mode: string) => {
      // No optimistic update — the driver confirms with a permission-mode
      // event (or surfaces an error), so the indicator never lies.
      if (live) sendToSession(threadKey, { type: "set-permission-mode", mode });
    },
    [live, threadKey],
  );

  const reportError = useCallback(
    (message: string) => {
      if (live) {
        dispatchToSession(threadKey, { type: "client-error", message, now: Date.now() });
      }
    },
    [live, threadKey],
  );

  const reportBrowserSurface = useCallback(
    (surface: BrowserSurfaceReport) => {
      // Fire-and-forget: this is ambient context, not a request. Dropping a
      // report while the socket is down costs one turn's browser context,
      // which is strictly better than queueing a URL that may be stale by the
      // time it reconnects.
      if (live) sendToSession(threadKey, { type: "browser-surface", ...surface });
    },
    [live, threadKey],
  );

  const respondToApproval = useCallback(
    (id: string, decision: PermissionDecision, updatedInput?: unknown) => {
      if (!live) return;
      if (!sendToSession(threadKey, { type: "permission-response", id, decision, updatedInput })) return;
      dispatchToSession(threadKey, { type: "approval-responded", id, decision });
    },
    [live, threadKey],
  );

  return useMemo(
    () => ({
      items: state.items,
      send,
      status: state.status,
      busy: state.busy,
      awaitingApproval: state.pendingApprovals.length > 0,
      pendingApproval: state.pendingApprovals[0] ?? null,
      pendingApprovals: state.pendingApprovals,
      respondToApproval,
      interrupt,
      contextTokens: state.contextTokens,
      sessionId: state.sessionId,
      permissionMode: state.permissionMode,
      setPermissionMode,
      reportError,
      reportBrowserSurface,
      capabilities: state.capabilities,
    }),
    [
      interrupt,
      reportBrowserSurface,
      reportError,
      respondToApproval,
      send,
      setPermissionMode,
      state,
    ],
  );
}

export type {
  ChatItem,
  ChatStatus,
  AgentOpts,
  PendingApproval,
  PermissionDecision,
};
export type { AgentCapabilities, BrowserSurfaceReport };
