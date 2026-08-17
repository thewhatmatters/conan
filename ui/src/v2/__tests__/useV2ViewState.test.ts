/**
 * useV2ViewState — the persisted WHA-60 sidebar ordering.
 *
 * The half worth pinning is not "it round-trips" but what happens when storage
 * lies: a hand-edited or half-written value is user-writable input, and the
 * comparators must never be handed a string that isn't one of the drawn
 * options. Each corrupt-input case below fails if `readViewState`'s validation
 * is reduced to a cast.
 *
 * The throwing-storage case matters because `localStorage` genuinely throws
 * (not returns null) in a partitioned or cookie-blocked context — the same
 * reason `entry.tsx` wraps its own read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  DEFAULT_VIEW_STATE,
  V2_VIEW_STATE_KEY,
  readViewState,
  useV2ViewState,
} from "../lib/useV2ViewState.ts";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("readViewState", () => {
  it("returns the defaults with nothing stored", () => {
    expect(readViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it("returns a stored pair", () => {
    localStorage.setItem(
      V2_VIEW_STATE_KEY,
      JSON.stringify({ projectOrder: "name", threadOrder: "agent" }),
    );

    expect(readViewState()).toEqual({
      projectOrder: "name",
      threadOrder: "agent",
    });
  });

  it("rejects an order the menu does not draw", () => {
    localStorage.setItem(
      V2_VIEW_STATE_KEY,
      JSON.stringify({ projectOrder: "size", threadOrder: "name" }),
    );

    // The bad half falls back; the good half survives.
    expect(readViewState()).toEqual({
      projectOrder: DEFAULT_VIEW_STATE.projectOrder,
      threadOrder: "name",
    });
  });

  it("rejects a thread order used in the project slot", () => {
    // `agent` is real, but only for threads — the mix-up a shared union of
    // strings would have let through.
    localStorage.setItem(
      V2_VIEW_STATE_KEY,
      JSON.stringify({ projectOrder: "agent" }),
    );

    expect(readViewState().projectOrder).toBe(DEFAULT_VIEW_STATE.projectOrder);
  });

  it("falls back on unparseable JSON", () => {
    localStorage.setItem(V2_VIEW_STATE_KEY, "{not json");

    expect(readViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it("falls back when the stored value is not an object", () => {
    localStorage.setItem(V2_VIEW_STATE_KEY, JSON.stringify("name"));

    expect(readViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it("falls back when the stored value is null", () => {
    // `typeof null === "object"` — the case a bare typeof check would miss.
    localStorage.setItem(V2_VIEW_STATE_KEY, JSON.stringify(null));

    expect(readViewState()).toEqual(DEFAULT_VIEW_STATE);
  });

  it("falls back when storage throws instead of returning null", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("partitioned storage");
    });

    expect(readViewState()).toEqual(DEFAULT_VIEW_STATE);
  });
});

describe("useV2ViewState", () => {
  it("starts from the defaults", () => {
    const { result } = renderHook(() => useV2ViewState());

    expect(result.current.projectOrder).toBe(DEFAULT_VIEW_STATE.projectOrder);
    expect(result.current.threadOrder).toBe(DEFAULT_VIEW_STATE.threadOrder);
  });

  it("hydrates from storage on mount", () => {
    localStorage.setItem(
      V2_VIEW_STATE_KEY,
      JSON.stringify({ projectOrder: "recentlyAdded", threadOrder: "name" }),
    );

    const { result } = renderHook(() => useV2ViewState());

    expect(result.current.projectOrder).toBe("recentlyAdded");
    expect(result.current.threadOrder).toBe("name");
  });

  it("persists a change so it survives a remount", () => {
    const first = renderHook(() => useV2ViewState());
    act(() => first.result.current.setProjectOrder("name"));

    const second = renderHook(() => useV2ViewState());

    expect(second.result.current.projectOrder).toBe("name");
  });

  it("writes both orders together, so one setter never drops the other", () => {
    const { result } = renderHook(() => useV2ViewState());

    act(() => result.current.setThreadOrder("agent"));
    act(() => result.current.setProjectOrder("name"));

    expect(JSON.parse(localStorage.getItem(V2_VIEW_STATE_KEY) ?? "{}")).toEqual({
      projectOrder: "name",
      threadOrder: "agent",
    });
  });

  it("still applies the setting for this session when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useV2ViewState());

    act(() => result.current.setProjectOrder("name"));

    expect(result.current.projectOrder).toBe("name");
  });
});
