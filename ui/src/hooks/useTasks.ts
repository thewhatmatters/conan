import { useEffect, useRef, useState } from "react";
import { ResilientSocket, type ConnStatus } from "../lib/resilientSocket.ts";

export type { ConnStatus };

export interface TaskStory {
  id: string;
  title: string;
  priority: number;
  passes: boolean;
}

export interface TasksState {
  exists: boolean;
  project: string;
  branchName: string;
  total: number;
  done: number;
  currentId: string | null;
  stories: TaskStory[];
  activity: string[];
}

export interface GatewayEvent {
  id: number;
  session_id: string;
  hook_event_name: string | null;
  stream_type: string | null;
  tool_name: string | null;
  parent_tool_use_id: string | null;
  /** Raw event payload as a JSON string (prompt text, tool input, etc.). */
  payload: string | null;
  ts: number;
}

export interface GatewayState {
  tasks: TasksState | null;
  /** Latest Claude Code event (US-005). `seq` increments so effects refire.
   *  `replay:true` marks an event re-sent by the server after a reconnect
   *  (US-018) so consumers like toasts can ignore the backfill. */
  lastEvent: (GatewayEvent & { seq: number; replay?: boolean }) | null;
  /** Live connection state for the header indicator (US-018). */
  status: ConnStatus;
  /** Bumps on every successful (re)connect so dependent hooks re-pull state. */
  reconnectSeq: number;
}

/**
 * Single app WebSocket to the gateway. Receives `{type:'tasks'}` (build-loop
 * progress) and `{type:'event'}` (Claude Code lifecycle events) and exposes the
 * latest of each. One connection feeds the Tasks tab, the timeline, and toasts.
 *
 * The socket self-heals (US-018): it heartbeats with ping/pong, reconnects with
 * exponential backoff, and on each (re)connect re-subscribes to the active
 * session channels so the server can replay events missed during the gap. The
 * `activeSessions` it re-subscribes to are read live from a ref, so changing the
 * selection never tears down the connection.
 */
export function useGateway(
  token: string | null,
  activeSessions: string[] = [],
): GatewayState {
  const [tasks, setTasks] = useState<TasksState | null>(null);
  const [lastEvent, setLastEvent] =
    useState<(GatewayEvent & { seq: number; replay?: boolean }) | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [reconnectSeq, setReconnectSeq] = useState(0);

  const activeRef = useRef(activeSessions);
  activeRef.current = activeSessions;

  useEffect(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then(setTasks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!token) return;
    let seq = 0;
    const sock = new ResilientSocket({
      url: () => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        return `${proto}://${location.host}/ws?token=${token}`;
      },
      heartbeatMs: 15_000,
      ping: () => JSON.stringify({ type: "ping" }),
      onStatus: setStatus,
      onOpen: (ws) => {
        setReconnectSeq((n) => n + 1);
        // Re-subscribe to the channels the UI is tracking; the server replays
        // each session's recent events so the timeline re-syncs across the gap.
        ws.send(
          JSON.stringify({ type: "subscribe", sessions: activeRef.current }),
        );
      },
      onMessage: (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "tasks") setTasks(msg.payload as TasksState);
          else if (msg.type === "event")
            setLastEvent({ ...(msg.payload as GatewayEvent), seq: ++seq });
          else if (msg.type === "replay")
            setLastEvent({
              ...(msg.payload as GatewayEvent),
              seq: ++seq,
              replay: true,
            });
          // hello / pong / subscribed: liveness only, no state change.
        } catch {
          /* ignore non-JSON frames */
        }
      },
    });
    return () => sock.close();
  }, [token]);

  return { tasks, lastEvent, status, reconnectSeq };
}
