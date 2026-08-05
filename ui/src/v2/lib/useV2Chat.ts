/**
 * v2 chat data adapter (US-201).
 *
 * Thin wrap over v1's presentation-agnostic `useAgentChat` — reuses the
 * /ws/agent socket + event fold; does NOT reimplement them. Gateway (`src/`)
 * and the hook itself are never modified.
 *
 * WHA-97 restores the permission/capabilities pass-throughs the skeleton
 * originally omitted so the v2 composer can follow live mode (and so the
 * context meter in WHA-101 has something to read).
 */
import {
  useAgentChat,
  type AgentOpts,
  type ChatItem,
  type ChatStatus,
  type OutgoingFileAttachment,
  type OutgoingImage,
  type PendingApproval,
  type PermissionDecision,
  type BrowserSurfaceReport,
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
  respondToApproval: (id: string, decision: PermissionDecision) => void;
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

export function useV2Chat(token: string | null): V2Chat {
  const chat = useAgentChat(token);
  return {
    items: chat.items,
    send: chat.send,
    status: chat.status,
    busy: chat.busy,
    awaitingApproval: chat.pendingApproval != null,
    pendingApproval: chat.pendingApproval,
    pendingApprovals: chat.pendingApprovals,
    respondToApproval: chat.respondToApproval,
    interrupt: chat.interrupt,
    contextTokens: chat.contextTokens,
    sessionId: chat.sessionId,
    permissionMode: chat.permissionMode,
    setPermissionMode: chat.setPermissionMode,
    reportError: chat.reportError,
    reportBrowserSurface: chat.reportBrowserSurface,
    capabilities: chat.capabilities,
  };
}

export type {
  ChatItem,
  ChatStatus,
  AgentOpts,
  PendingApproval,
  PermissionDecision,
};
export type { AgentCapabilities, BrowserSurfaceReport };
