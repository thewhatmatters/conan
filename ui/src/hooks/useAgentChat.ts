import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "../lib/gateway.ts";

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
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  /** Working directory for the session — the FIRST prompt's cwd fixes it
   *  (US-001); omitted → the gateway's active cwd. */
  cwd?: string;
}

/** Coarse tool classification mirrored from src/agent/driver.ts. */
export type ToolPermissionKind = "command" | "file-read" | "file-change" | "other";

/** The user's answer to a pending approval (mirrors PermissionDecision). */
export type PermissionDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/** A Supervised-mode permission request awaiting the user's decision. */
export interface PendingApproval {
  id: string;
  toolKind: ToolPermissionKind;
  summary: string;
  detail: string;
  toolName: string;
}

/** Normalized agent event mirrored from src/agent/driver.ts. */
type AgentEvent =
  | { kind: "system"; sessionId: string | null; model: string | null; cwd: string | null; tools: string[] }
  | { kind: "assistant-text"; text: string; delta?: boolean }
  | { kind: "reasoning"; text: string; delta?: boolean }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; id: string; content: string; isError: boolean }
  | { kind: "permission-request"; id: string; toolKind: ToolPermissionKind; summary: string; detail: string; toolName: string }
  | { kind: "result"; isError: boolean; costUsd: number | null; durationMs: number | null; numTurns: number | null; text: string | null }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string };

/** A rendered transcript item. */
export type ChatItem =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "reasoning"; text: string }
  | { id: string; role: "tool"; name: string; input: unknown; result: string | null; isError: boolean }
  | { id: string; role: "result"; costUsd: number | null; durationMs: number | null; numTurns: number | null }
  | { id: string; role: "system"; model: string | null; cwd: string | null }
  | { id: string; role: "error"; message: string };

export type ChatStatus = "connecting" | "open" | "closed";

export interface AgentChat {
  items: ChatItem[];
  busy: boolean;
  status: ChatStatus;
  /** The real Claude session id, from the system init event. Survives across
   *  turns (the process is long-lived); updates if the session respawns. */
  sessionId: string | null;
  /** The latest unanswered Supervised-mode permission request, or null. The
   *  driver blocks the turn on it, so at most one is pending at a time.
   *  Cleared by respondToApproval or by the turn ending (result/exit/error). */
  pendingApproval: PendingApproval | null;
  /** Answer a pending permission request. */
  respondToApproval: (id: string, decision: PermissionDecision) => void;
  /** Submit a user turn (no-op while busy or disconnected). */
  send: (text: string, opts: AgentOpts) => void;
  /** Stop the in-flight turn (graceful interrupt — the session survives). */
  interrupt: () => void;
}

export function useAgentChat(token: string | null): AgentChat {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const seq = useRef(0);
  const nextId = () => `i${++seq.current}`;

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(`/ws/agent?token=${token}`));
    wsRef.current = ws;
    ws.onopen = () => setStatus("open");
    ws.onclose = () => {
      setStatus("closed");
      // Nobody is listening for an answer anymore.
      setPendingApproval(null);
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
      ws.onmessage = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** Fold one normalized event into the flat transcript. */
  const applyEvent = useCallback((e: AgentEvent) => {
    // Session-level state rides alongside the transcript fold.
    if (e.kind === "system") {
      setSessionId(e.sessionId);
    } else if (e.kind === "permission-request") {
      setPendingApproval({
        id: e.id,
        toolKind: e.toolKind,
        summary: e.summary,
        detail: e.detail,
        toolName: e.toolName,
      });
    } else if (e.kind === "result" || e.kind === "exit" || e.kind === "error") {
      // The turn is over — any unanswered request was settled driver-side.
      setPendingApproval(null);
    }
    setItems((prev) => {
      switch (e.kind) {
        case "system":
          return [...prev, { id: nextId(), role: "system", model: e.model, cwd: e.cwd }];
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
        case "result":
          return [
            ...prev,
            { id: nextId(), role: "result", costUsd: e.costUsd, durationMs: e.durationMs, numTurns: e.numTurns },
          ];
        case "exit":
          return [
            ...prev,
            { id: nextId(), role: "error", message: `Session ended${e.code != null ? ` (exit ${e.code})` : ""}.` },
          ];
        case "error":
          return [...prev, { id: nextId(), role: "error", message: e.message }];
        default:
          return prev;
      }
    });
  }, []);

  const send = useCallback(
    (text: string, opts: AgentOpts) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN || busy || !text.trim()) return;
      setItems((prev) => [...prev, { id: nextId(), role: "user", text }]);
      ws.send(JSON.stringify({ type: "prompt", text, ...opts }));
    },
    [busy],
  );

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  const respondToApproval = useCallback((id: string, decision: PermissionDecision) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "permission-response", id, decision }));
    // Clear optimistically — the driver ignores unknown/settled ids, and a
    // fresh request would arrive as its own permission-request event.
    setPendingApproval((prev) => (prev && prev.id === id ? null : prev));
  }, []);

  return { items, busy, status, sessionId, pendingApproval, respondToApproval, send, interrupt };
}
