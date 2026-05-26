import { useEffect, useState } from "react";
import type { GatewayEvent } from "./useTasks.ts";

/** A persisted event row for the ActivityTimeline (matches the gateway shape). */
export interface TimelineEvent {
  id: number;
  session_id: string;
  parent_tool_use_id: string | null;
  hook_event_name: string | null;
  stream_type: string | null;
  tool_name: string | null;
  payload: string | null;
  ts: number;
}

/** The session ▾ sentinel that selects every session's events (US-007). */
export const ALL_SESSIONS = "all";

/**
 * Loads the selected session's event history from
 * GET /api/claude/sessions/:id/events (US-011) and appends live events that
 * arrive over the app WS, so the timeline stays current without its own socket.
 * Returns events oldest-first. Resets when the selected session changes.
 *
 * When `sessionId` is the ALL_SESSIONS sentinel (US-007), it loads the
 * cross-session history from GET /api/claude/events and live-appends every
 * event regardless of which session it belongs to.
 */
export function useSessionEvents(
  sessionId: string | null,
  lastEvent: (GatewayEvent & { seq: number }) | null,
): TimelineEvent[] {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const all = sessionId === ALL_SESSIONS;

  // Initial history load (and reset) when the selected session changes.
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    const url = all
      ? "/api/claude/events"
      : `/api/claude/sessions/${encodeURIComponent(sessionId)}/events`;
    let cancelled = false;
    fetch(url)
      .then((r) => r.json())
      .then((rows) => {
        if (!cancelled) setEvents(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, all]);

  // Live append: push the latest WS event when it belongs to this session (or
  // always, in All-sessions view) and hasn't already been loaded (de-dupe by
  // id, so history + live never double).
  useEffect(() => {
    if (!sessionId || !lastEvent) return;
    if (!all && lastEvent.session_id !== sessionId) return;
    setEvents((prev) => {
      if (prev.some((e) => e.id === lastEvent.id)) return prev;
      const { seq: _seq, ...row } = lastEvent;
      return [...prev, row];
    });
    // Keyed on seq so each distinct WS event fires exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, all, lastEvent?.seq]);

  return events;
}
