/**
 * WHA-105 — the sidebar pill now comes from the live session registry, so it
 * describes every thread with an open session and not only the mounted one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { pillOf, useV2ThreadStates } from "../lib/useV2ThreadState.ts";
import { acquireSession, closeAllSessions } from "../../chat/sessionStore.ts";

let opened: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    opened.push(this);
  }
  send(): void {}
  close(): void {}
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

describe("useV2ThreadStates", () => {
  it("derives a pill per live session and idle for threads with none", () => {
    acquireSession("one", "tok");
    opened[0]!.onopen?.();
    opened[0]!.emit({ type: "busy", busy: true });

    const { result } = renderHook(() => useV2ThreadStates());

    expect(pillOf(result.current.one)).toBe("working");
    expect(pillOf(result.current.two)).toBe("idle");
  });

  it("prioritizes approval over busy, then ready over idle", () => {
    expect(
      pillOf({ status: "open", busy: true, awaitingApproval: true }),
    ).toBe("awaiting");
    expect(
      pillOf({ status: "open", busy: false, awaitingApproval: false }),
    ).toBe("ready");
    expect(
      pillOf({ status: "closed", busy: false, awaitingApproval: false }),
    ).toBe("idle");
  });
});
