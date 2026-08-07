/**
 * useV2Chat — the v2 chat surface over the live session registry (US-201).
 *
 * Proves the seam exposes the p2a surface (plus WHA-97 permission/capabilities
 * pass-throughs), opens no socket without a token or a selection, and — the
 * WHA-105 fix — that unmounting the hook does not end the thread's session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useV2Chat } from "../lib/useV2Chat.ts";
import { closeAllSessions } from "../../chat/sessionStore.ts";

let opened: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
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
  }
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

describe("useV2Chat", () => {
  it("exposes items, send, status, busy, approval state (and interrupt for stop)", () => {
    const { result } = renderHook(() => useV2Chat(null, null));

    expect(result.current.items).toEqual([]);
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.interrupt).toBe("function");
    expect(result.current.busy).toBe(false);
    expect(result.current.awaitingApproval).toBe(false);
    expect(result.current.pendingApproval).toBeNull();
    expect(result.current.pendingApprovals).toEqual([]);
    expect(typeof result.current.respondToApproval).toBe("function");
    // No token → no socket → stays connecting (nothing is acquired).
    expect(result.current.status).toBe("connecting");
    expect(opened).toHaveLength(0);
  });

  // WHA-97: restore the six pass-throughs the skeleton omitted. Without these
  // the v2 composer cannot follow live permission mode, and WHA-101 has no
  // contextTokens/capabilities to meter.
  it("passes through permission, session, capabilities, and error surfaces", () => {
    const { result } = renderHook(() => useV2Chat(null, null));

    expect(result.current.contextTokens).toBeNull();
    expect(result.current.sessionId).toBeNull();
    expect(result.current.permissionMode).toBeNull();
    expect(result.current.capabilities).toBeNull();
    expect(typeof result.current.setPermissionMode).toBe("function");
    expect(typeof result.current.reportError).toBe("function");
  });

  it("opens no session for a thread key without a token", () => {
    renderHook(() => useV2Chat(null, "thread-a"));
    expect(opened).toHaveLength(0);
  });

  // WHA-105 — the regression this hook was rewritten for. Unmounting is a
  // thread switch, not the end of the conversation.
  it("leaves the session running when the view unmounts, and re-attaches to it", () => {
    const first = renderHook(() => useV2Chat("tok", "thread-a"));
    const socket = opened[0]!;
    act(() => {
      socket.onopen?.();
      socket.emit({
        type: "event",
        event: { kind: "assistant-text", text: "streamed while visible" },
      });
    });
    expect(first.result.current.items).toHaveLength(1);

    first.unmount();
    expect(socket.closeCount).toBe(0);

    // The turn keeps producing output with nothing rendering it.
    socket.emit({
      type: "event",
      event: { kind: "assistant-text", text: "streamed in the background" },
    });

    const back = renderHook(() => useV2Chat("tok", "thread-a"));
    expect(opened).toHaveLength(1);
    expect(back.result.current.items).toHaveLength(2);
    expect(back.result.current.items[1]).toMatchObject({
      text: "streamed in the background",
    });
  });

  it("sends a prompt on the thread's socket and shows it in the transcript", () => {
    const { result } = renderHook(() => useV2Chat("tok", "thread-a"));
    act(() => {
      opened[0]!.onopen?.();
    });

    act(() => {
      result.current.send("do the thing", { cwd: "/repo" });
    });

    expect(JSON.parse(opened[0]!.sent[0]!)).toMatchObject({
      type: "prompt",
      text: "do the thing",
      cwd: "/repo",
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      role: "user",
      text: "do the thing",
    });
  });

  it("sends interactive answers on the permission-response frame", () => {
    const { result } = renderHook(() => useV2Chat("tok", "thread-a"));
    act(() => opened[0]!.onopen?.());

    act(() => {
      result.current.respondToApproval("ask-1", "accept", {
        questions: [{ question: "Where?" }],
        answers: { "Where?": "Vault" },
      });
    });

    expect(JSON.parse(opened[0]!.sent[0]!)).toEqual({
      type: "permission-response",
      id: "ask-1",
      decision: "accept",
      updatedInput: {
        questions: [{ question: "Where?" }],
        answers: { "Where?": "Vault" },
      },
    });
  });
});
