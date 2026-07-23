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
}

/** Normalized agent event mirrored from src/agent/driver.ts. */
type AgentEvent =
  | { kind: "system"; sessionId: string | null; model: string | null; cwd: string | null; tools: string[] }
  | { kind: "assistant-text"; text: string; delta?: boolean }
  | { kind: "reasoning"; text: string; delta?: boolean }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; id: string; content: string; isError: boolean }
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
  /** Submit a user turn (no-op while busy or disconnected). */
  send: (text: string, opts: AgentOpts) => void;
  /** Stop the in-flight turn (kills the underlying process for the spike). */
  interrupt: () => void;
}

export function useAgentChat(token: string | null): AgentChat {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ChatStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const seq = useRef(0);
  const nextId = () => `i${++seq.current}`;

  useEffect(() => {
    if (!token) return;
    const ws = new WebSocket(wsUrl(`/ws/agent?token=${token}`));
    wsRef.current = ws;
    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
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

  return { items, busy, status, send, interrupt };
}
