/**
 * WHA-105 — a thread's agent session survives the view that renders it.
 *
 * The bug: `V2ChatView` is keyed on the sidebar selection, so switching
 * threads unmounted it; `useAgentChat` closed its socket on unmount; the
 * gateway disposes the driver on socket close and SIGTERMs the agent process.
 * Switching away from a working thread killed the turn and lost its output.
 *
 * These tests drive the registry directly with a fake WebSocket, because the
 * only thing that actually matters is whether `close()` was called — a fact no
 * amount of rendering makes more visible. THE REGRESSION TEST is "the socket
 * stays open after the last listener leaves": it fails against the old
 * unmount-closes-the-socket design.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSession,
  closeAllSessions,
  closeSession,
  getLiveThreadStates,
  getSessionState,
  sendToSession,
  subscribeToSession,
} from "../sessionStore.ts";

/** Every socket the store opened during a test, newest last. */
let opened: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeSocket.OPEN;
  closeCount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    opened.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  /** Deliver a gateway frame, as the real socket would. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  closeAllSessions();
  vi.unstubAllGlobals();
});

/** Open a session and put a turn in flight, as a real thread would be. */
function startWorkingThread(key: string): FakeSocket {
  acquireSession(key, "tok");
  const socket = opened[opened.length - 1]!;
  socket.onopen?.();
  socket.emit({ type: "busy", busy: true });
  socket.emit({
    type: "event",
    event: { kind: "assistant-text", text: "half an answer", delta: true },
  });
  return socket;
}

describe("agent session registry", () => {
  it("keeps the socket open when the last subscriber leaves (WHA-105)", () => {
    const unsubscribe = subscribeToSession("thread-a", "tok", () => {});
    const socket = opened[0]!;
    socket.onopen?.();
    socket.emit({ type: "busy", busy: true });

    // The thread switch: the view unmounts and drops its subscription.
    unsubscribe();

    expect(socket.closeCount).toBe(0);
    expect(getSessionState("thread-a").busy).toBe(true);
  });

  it("keeps streaming into the session while another thread is on screen", () => {
    const working = startWorkingThread("thread-a");
    const unsubscribe = subscribeToSession("thread-a", "tok", () => {});
    unsubscribe();

    // Switch to another thread — its own session, its own socket.
    subscribeToSession("thread-b", "tok", () => {});
    expect(opened).toHaveLength(2);
    expect(working.closeCount).toBe(0);

    // The background turn finishes while B is on screen.
    working.emit({
      type: "event",
      event: { kind: "assistant-text", text: " and the rest", delta: true },
    });
    working.emit({ type: "busy", busy: false });

    const items = getSessionState("thread-a").items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      role: "assistant",
      text: "half an answer and the rest",
    });
    expect(getSessionState("thread-a").busy).toBe(false);
  });

  it("re-attaches the same session on the way back, with no second socket", () => {
    const socket = startWorkingThread("thread-a");
    subscribeToSession("thread-a", "tok", () => {})();

    const listener = vi.fn();
    subscribeToSession("thread-a", "tok", listener);

    expect(opened).toHaveLength(1);
    expect(getSessionState("thread-a").items).toHaveLength(1);

    socket.emit({ type: "busy", busy: false });
    expect(listener).toHaveBeenCalled();
  });

  it("closes the socket only when the thread itself ends", () => {
    const socket = startWorkingThread("thread-a");

    closeSession("thread-a");

    expect(socket.closeCount).toBe(1);
    // A local teardown, so the reducer's "connection lost" notice must not
    // fire — the handlers are detached before the close.
    expect(socket.onclose).toBeNull();
    expect(getSessionState("thread-a").items).toHaveLength(0);
  });

  it("reports live pill state for every session, not just the visible one", () => {
    const a = startWorkingThread("thread-a");
    subscribeToSession("thread-a", "tok", () => {})();
    const b = startWorkingThread("thread-b");
    b.emit({ type: "busy", busy: false });

    expect(getLiveThreadStates()).toEqual({
      "thread-a": { status: "open", busy: true, awaitingApproval: false },
      "thread-b": { status: "open", busy: false, awaitingApproval: false },
    });

    a.emit({ type: "busy", busy: false });
    expect(getLiveThreadStates()["thread-a"]).toEqual({
      status: "open",
      busy: false,
      awaitingApproval: false,
    });
  });

  it("evicts the least-recently-used IDLE session past the cap, never a busy one", () => {
    // One busy thread, then enough idle ones to exceed MAX_LIVE_SESSIONS (6).
    const busy = startWorkingThread("busy");
    for (let i = 0; i < 6; i += 1) {
      acquireSession(`idle-${i}`, "tok");
      opened[opened.length - 1]!.onopen?.();
    }

    expect(busy.closeCount).toBe(0);
    const live = Object.keys(getLiveThreadStates());
    expect(live).toContain("busy");
    // The oldest idle session went, not the working one.
    expect(live).not.toContain("idle-0");
    expect(live).toHaveLength(6);
  });

  it("never evicts a session a view is still subscribed to", () => {
    subscribeToSession("visible", "tok", () => {});
    const visible = opened[0]!;
    visible.onopen?.();
    for (let i = 0; i < 8; i += 1) {
      acquireSession(`idle-${i}`, "tok");
      opened[opened.length - 1]!.onopen?.();
    }

    expect(visible.closeCount).toBe(0);
    expect(Object.keys(getLiveThreadStates())).toContain("visible");
  });

  it("sends outgoing frames on the thread's own socket", () => {
    const a = startWorkingThread("thread-a");
    const b = startWorkingThread("thread-b");

    expect(sendToSession("thread-b", { type: "interrupt" })).toBe(true);
    expect(b.sent).toEqual([JSON.stringify({ type: "interrupt" })]);
    expect(a.sent).toEqual([]);
    // No live session for that key — the caller must be able to tell.
    expect(sendToSession("nobody", { type: "interrupt" })).toBe(false);
  });

  it("replaces the session when the gateway token changes", () => {
    const first = startWorkingThread("thread-a");
    acquireSession("thread-a", "rotated");

    expect(first.closeCount).toBe(1);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.url).toContain("token=rotated");
  });
});
