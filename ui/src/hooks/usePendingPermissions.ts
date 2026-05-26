import { useCallback, useEffect, useState } from "react";

/** A permission prompt awaiting a decision (matches the gateway shape, US-013). */
export interface PendingPermission {
  sessionId: string;
  requestId: string;
  toolName: string | null;
  /** The tool input the agent wants to run (JSON-ish), for the "action" line. */
  input: unknown;
  ts: number;
  /**
   * The real options Claude Code offered for this prompt (US-008), passed
   * through from the control_request. Used to render the actual choices
   * (e.g. allow / allow-don't-ask-again / deny) instead of a hardcoded pair.
   */
  permissionSuggestions?: unknown;
}

/**
 * Loads every cross-session pending permission prompt from
 * GET /api/claude/permissions (US-013) and refetches whenever a Claude Code
 * event arrives over the app WS — so prompts appear when a control_request lands
 * and clear when a control_cancel/response resolves them, with no own socket.
 * `eventSeq` is the monotonically-increasing seq from useGateway's lastEvent.
 */
export function usePendingPermissions(eventSeq: number | null): {
  pending: PendingPermission[];
  refresh: () => void;
} {
  const [pending, setPending] = useState<PendingPermission[]>([]);

  const refresh = useCallback(() => {
    fetch("/api/claude/permissions")
      .then((r) => r.json())
      .then((rows) => setPending(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, eventSeq]);

  return { pending, refresh };
}
