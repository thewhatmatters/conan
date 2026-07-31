/**
 * v2 chat data adapter (US-201).
 *
 * Thin wrap over v1's presentation-agnostic `useAgentChat` — reuses the
 * /ws/agent socket + event fold; does NOT reimplement them. Exposes only the
 * surface the walking skeleton needs. Gateway (`src/`) and the hook itself
 * are never modified.
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
} from "../../hooks/useAgentChat.ts";

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
  };
}

export type {
  ChatItem,
  ChatStatus,
  AgentOpts,
  PendingApproval,
  PermissionDecision,
};
