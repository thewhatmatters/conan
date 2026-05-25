import { useEffect, useState } from "react";

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
  tool_name: string | null;
  parent_tool_use_id: string | null;
  ts: number;
}

export interface GatewayState {
  tasks: TasksState | null;
  /** Latest Claude Code event (US-005). `seq` increments so effects refire. */
  lastEvent: (GatewayEvent & { seq: number }) | null;
}

/**
 * Single app WebSocket to the gateway. Receives `{type:'tasks'}` (build-loop
 * progress) and `{type:'event'}` (Claude Code lifecycle events) and exposes the
 * latest of each. One connection feeds the Tasks tab, the timeline, and toasts.
 */
export function useGateway(token: string | null): GatewayState {
  const [tasks, setTasks] = useState<TasksState | null>(null);
  const [lastEvent, setLastEvent] =
    useState<(GatewayEvent & { seq: number }) | null>(null);

  useEffect(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then(setTasks)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
    let seq = 0;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "tasks") setTasks(msg.payload as TasksState);
        else if (msg.type === "event")
          setLastEvent({ ...(msg.payload as GatewayEvent), seq: ++seq });
      } catch {
        /* ignore non-JSON frames */
      }
    };
    return () => ws.close();
  }, [token]);

  return { tasks, lastEvent };
}
