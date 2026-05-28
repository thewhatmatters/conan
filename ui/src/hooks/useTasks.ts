import { useEffect, useRef, useState } from "react";
import { ResilientSocket, type ConnStatus } from "../lib/resilientSocket.ts";
import { apiBase, wsUrl } from "../lib/gateway.ts";

export type { ConnStatus };

export interface TaskStory {
  id: string;
  title: string;
  priority: number;
  passes: boolean;
}

export interface TasksState {
  exists: boolean;
  /** Active cwd has a task source — prd.json, or progress.txt with content
   *  (US-039). The Tasks tab is hidden entirely when false. */
  hasSource: boolean;
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

/**
 * The skill-fired WS envelope (US-002): the live transcript-watcher emits one
 * of these whenever a new Skill tool_use lands in a session's JSONL. The
 * Timeline split panel (US-004) consumes these scoped to its active session.
 */
export interface SkillFiredEvent {
  sessionId: string;
  payload: {
    kind: "skill-fired";
    ts: number;
    skill: string;
    promptEventId?: number;
    detail?: string;
  };
  /** Bumps on every received broadcast so effects retrigger. */
  seq: number;
}

/**
 * The skill-considered WS envelope (US-003): the ingest path emits one per
 * top-scored skill for each UserPromptSubmit. Labelled `heuristic: true` —
 * this is Conan's BM25 description match, NOT Claude's real scoring (US-004).
 */
export interface SkillConsideredEvent {
  sessionId: string;
  payload: {
    kind: "skill-considered";
    ts: number;
    eventId?: number;
    skill: string;
    promptEventId?: number;
    reason: string;
    heuristic: true;
  };
  seq: number;
}

/** A streamed ultrareview run (US-046), mirrors the gateway UltrareviewRun. */
export interface UltrareviewRun {
  id: string;
  status: "idle" | "running" | "done" | "error";
  target: { kind: "branch" | "pr"; ref: string | null };
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  output: string;
  findingsCount: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface GatewayState {
  tasks: TasksState | null;
  /** Latest Claude Code event (US-005). `seq` increments so effects refire.
   *  `replay:true` marks an event re-sent by the server after a reconnect
   *  (US-018) so consumers like toasts can ignore the backfill. */
  lastEvent: (GatewayEvent & { seq: number; replay?: boolean }) | null;
  /** Latest ultrareview run pushed over /ws (US-046), or null until one streams. */
  lastUltrareview: UltrareviewRun | null;
  /** Latest `{type:'skill-fired'}` broadcast (US-002 v4.5). Seq retriggers effects. */
  lastSkillFired: SkillFiredEvent | null;
  /** Latest `{type:'skill-considered'}` broadcast (US-003 v4.5). Seq retriggers effects. */
  lastSkillConsidered: SkillConsideredEvent | null;
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
  const [lastUltrareview, setLastUltrareview] = useState<UltrareviewRun | null>(null);
  const [lastSkillFired, setLastSkillFired] = useState<SkillFiredEvent | null>(null);
  const [lastSkillConsidered, setLastSkillConsidered] =
    useState<SkillConsideredEvent | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [reconnectSeq, setReconnectSeq] = useState(0);

  const activeRef = useRef(activeSessions);
  activeRef.current = activeSessions;

  useEffect(() => {
    fetch(apiBase() + "/api/tasks")
      .then((r) => r.json())
      .then(setTasks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!token) return;
    let seq = 0;
    const sock = new ResilientSocket({
      url: () => wsUrl(`/ws?token=${token}`),
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
          else if (msg.type === "ultrareview")
            setLastUltrareview(msg.payload as UltrareviewRun);
          else if (msg.type === "skill-fired")
            setLastSkillFired({
              sessionId: String(msg.sessionId ?? ""),
              payload: msg.payload as SkillFiredEvent["payload"],
              seq: ++seq,
            });
          else if (msg.type === "skill-considered")
            setLastSkillConsidered({
              sessionId: String(msg.sessionId ?? ""),
              payload: msg.payload as SkillConsideredEvent["payload"],
              seq: ++seq,
            });
          // hello / pong / subscribed: liveness only, no state change.
        } catch {
          /* ignore non-JSON frames */
        }
      },
    });
    return () => sock.close();
  }, [token]);

  return {
    tasks,
    lastEvent,
    lastUltrareview,
    lastSkillFired,
    lastSkillConsidered,
    status,
    reconnectSeq,
  };
}
