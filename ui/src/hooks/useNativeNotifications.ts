import { useEffect, useRef } from "react";
import type { GatewayEvent, TasksState } from "./useTasks.ts";
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
  /** Build-loop task state — drives the `US-XXX complete` native notification
   *  when a story flips from passes:false to passes:true. */
  tasks: TasksState | null;
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
 * Inspect a PostToolUse payload and decide whether it represents a tool
 * failure. Claude Code reports tool failures in a couple of shapes — most
 * commonly `tool_response.is_error: true`, sometimes a string `error` field.
 * Returns the failure message when present, else null.
 */
function toolFailureMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const resp = (p.tool_response ?? null) as Record<string, unknown> | null;
  if (resp) {
    if (resp.is_error === true) {
      const content = typeof resp.content === "string" ? resp.content : "";
      const error = typeof resp.error === "string" ? resp.error : "";
      return (content || error || "Tool reported an error").slice(0, 200);
    }
    if (typeof resp.error === "string" && resp.error) return resp.error.slice(0, 200);
  }
  return null;
}

/**
 * Native notification fan-out: the single surface that turns signal-grade
 * events into macOS banners when running under Tauri. The browser dev view
 * sees nothing here — `<Toaster>` is the fallback there.
 *
 * Fires for three event classes, each with its own suppression:
 *  - **Notification hook** — Claude needs your input. Throttled per session
 *    so a re-prompting agent can't spam banners; suppressed when the prompt's
 *    session is the visible one and the window is focused (you'd see it live).
 *  - **PostToolUse failure** — a tool errored. Same per-session throttle so a
 *    retry-loop can't fan out one banner per attempt.
 *  - **Build-loop story passing** — a `prd.json` story flipped to passes:true.
 *    No throttle needed (each story fires once); shown unconditionally so a
 *    background loop completion is visible.
 *
 * Clicking a banner focuses Conan and selects the correlated terminal tab
 * via a `conan:focus-session` window event TerminalPane listens for.
 */
export function useNativeNotifications({
  lastEvent,
  sessions,
  tasks,
}: Args): void {
  // Last notification per session, to throttle repeats.
  const lastBySession = useRef<Map<string, { ts: number; msg: string }>>(
    new Map(),
  );
  // The session a click should focus (the most-recently-notified one).
  const pendingSession = useRef<string | null>(null);
  // Snapshot of which stories were already passing on the previous tick, so
  // we only notify on the false → true edge (mirrors the Toaster pattern).
  const prevPasses = useRef<Map<string, boolean> | null>(null);

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

  // --- Notification hook + PostToolUse failure ----------------------------
  useEffect(() => {
    if (!isTauri()) return; // browser → Toaster fallback
    const ev = lastEvent;
    if (!ev || ev.replay) return; // ignore reconnect backfill

    const sid = ev.session_id;
    if (!sid) return;

    let title: string;
    let message: string;

    if (ev.hook_event_name === "Notification") {
      // The hook payload carries `message` (e.g. "Claude needs your permission…").
      message = "Claude needs your attention.";
      try {
        const p = ev.payload ? JSON.parse(ev.payload) : null;
        if (p && typeof p.message === "string" && p.message) message = p.message;
      } catch {
        /* non-JSON payload — keep the default */
      }
      title = sessionTitle(
        sessions.find((s) => s.id === sid),
        sid,
      );
    } else if (ev.hook_event_name === "PostToolUse") {
      let failure: string | null = null;
      try {
        const p = ev.payload ? JSON.parse(ev.payload) : null;
        failure = toolFailureMessage(p);
      } catch {
        /* non-JSON payload — skip */
      }
      if (!failure) return;
      const tool = ev.tool_name ?? "tool";
      title = `${tool} failed`;
      message = failure;
    } else {
      return;
    }

    // (We used to suppress native banners when Conan was focused AND the
    // firing session was the visible terminal — the assumption was "the user
    // sees it live, no banner needed". In practice the user might be focused
    // on Conan while reading docs, browsing tabs, etc., not staring at the
    // pty; and macOS already de-emphasises banners for focused apps when
    // it wants to. Removed so the signal reliably surfaces.)

    // De-dupe/throttle repeats for the same session + same message.
    const now = Date.now();
    const prev = lastBySession.current.get(sid);
    if (prev && now - prev.ts < THROTTLE_MS && prev.msg === message) return;
    lastBySession.current.set(sid, { ts: now, msg: message });
    pendingSession.current = sid;

    void sendNativeNotification(title, message);
    // Only refire on a new event, not on sessions/visibility churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent?.seq]);

  // --- Build-loop task completions (false → true edge) ---------------------
  useEffect(() => {
    if (!isTauri()) return;
    if (!tasks) return;
    const next = new Map(tasks.stories.map((s) => [s.id, s.passes]));
    const prev = prevPasses.current;
    if (prev) {
      for (const s of tasks.stories) {
        if (s.passes && prev.get(s.id) === false) {
          void sendNativeNotification(
            `${s.id} complete`,
            s.title ?? "Build-loop story passed",
          );
        }
      }
    }
    prevPasses.current = next;
  }, [tasks]);
}
