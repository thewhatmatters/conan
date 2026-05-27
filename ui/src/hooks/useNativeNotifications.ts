import { useEffect, useRef } from "react";
import type { GatewayEvent } from "./useTasks.ts";
import type { Session } from "./useSessions.ts";
import { isTauri } from "../lib/gateway.ts";
import { sendNativeNotification, onNotificationClick } from "../lib/nativeNotify.ts";

/** De-dupe/throttle window: a repeat Notification for the same session inside
 *  this many ms is suppressed so a re-prompting agent never spams banners. */
const THROTTLE_MS = 8000;

interface Args {
  /** Latest app-WS event (useGateway.lastEvent). */
  lastEvent: (GatewayEvent & { seq: number; replay?: boolean }) | null;
  /** The session grid, to title the banner by session name / cwd. */
  sessions: Session[];
  /** The session id whose terminal is currently visible/active; when the window
   *  is focused AND this matches the event's session the user is already looking
   *  at it, so we suppress the banner. */
  visibleSessionId: string | null;
}

/** A short, human title for the banner: session name → cwd basename → short id. */
function sessionTitle(sess: Session | undefined, sessionId: string): string {
  if (sess?.title) return `Claude · ${sess.title}`;
  const cwd = sess?.cwd;
  if (cwd) {
    const base = cwd.replace(/\/+$/, "").split("/").pop();
    if (base) return `Claude · ${base}`;
  }
  return `Claude · ${sessionId.slice(0, 8)}`;
}

/**
 * US-011: fire a native macOS notification whenever a `Notification` hook event
 * arrives over the app WS (Claude needs permission / is waiting for input), so a
 * user in another app is pulled back to acknowledge it. Tauri only — in the
 * browser dev view this is inert and the in-app Toaster is the fallback surface.
 *
 * Suppressed when the user would not miss it (window focused AND the correlated
 * terminal is the visible one) and throttled per-session against re-prompts.
 * Clicking the banner focuses Conan and selects the correlated terminal tab via
 * a `conan:focus-session` window event TerminalPane listens for.
 */
export function useNativeNotifications({
  lastEvent,
  sessions,
  visibleSessionId,
}: Args): void {
  // Last notification per session, to throttle repeats.
  const lastBySession = useRef<Map<string, { ts: number; msg: string }>>(
    new Map(),
  );
  // The session a click should focus (the most-recently-notified one).
  const pendingSession = useRef<string | null>(null);

  // Wire the click→focus handler once.
  useEffect(() => {
    if (!isTauri()) return;
    let cleanup = () => {};
    onNotificationClick(() => {
      const sid = pendingSession.current;
      if (sid)
        window.dispatchEvent(
          new CustomEvent("conan:focus-session", { detail: { sessionId: sid } }),
        );
    }).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup();
  }, []);

  useEffect(() => {
    if (!isTauri()) return; // browser → Toaster fallback
    const ev = lastEvent;
    if (!ev || ev.replay) return; // ignore reconnect backfill
    if (ev.hook_event_name !== "Notification") return;

    const sid = ev.session_id;
    if (!sid) return;

    // The hook payload carries `message` (e.g. "Claude needs your permission…").
    let message = "Claude needs your attention.";
    try {
      const p = ev.payload ? JSON.parse(ev.payload) : null;
      if (p && typeof p.message === "string" && p.message) message = p.message;
    } catch {
      /* non-JSON payload — keep the default */
    }

    // Suppress when the user is already looking at this session's terminal.
    if (
      typeof document !== "undefined" &&
      document.hasFocus() &&
      sid === visibleSessionId
    )
      return;

    // De-dupe/throttle repeats for the same session.
    const now = Date.now();
    const prev = lastBySession.current.get(sid);
    if (prev && now - prev.ts < THROTTLE_MS && prev.msg === message) return;
    lastBySession.current.set(sid, { ts: now, msg: message });
    pendingSession.current = sid;

    const title = sessionTitle(
      sessions.find((s) => s.id === sid),
      sid,
    );
    void sendNativeNotification(title, message);
    // Only refire on a new event, not on sessions/visibility churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent?.seq]);
}
