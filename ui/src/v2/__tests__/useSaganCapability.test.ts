import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAGAN_POLL_INTERVAL_MS,
  useSaganCapability,
} from "../lib/useSaganCapability.ts";
import type { ActiveThread } from "../lib/types.ts";
import type { V2ProjectWithThreads } from "../lib/useV2Projects.ts";

const thread = { projectId: "p1", cwd: "/repo/one" } as ActiveThread;
const projects = [{ id: "p1", path: "/repo/one", threads: [] }] as unknown as V2ProjectWithThreads[];
const payload = (count: number, root = "/repo/one") => ({
  project: { path: "/repo/one", root, sagan: { state: "valid" } },
  runs: Array.from({ length: count }, (_, index) => ({ id: String(index), openDecisions: [] })),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSaganCapability live refresh", () => {
  it("polls only while visible and preserves data through a failed refresh", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload(1) })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, json: async () => payload(2) });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ visible }) => useSaganCapability("tok", thread, projects, visible),
      { initialProps: { visible: true } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.data?.runs).toHaveLength(1);

    await act(async () => void await vi.advanceTimersByTimeAsync(SAGAN_POLL_INTERVAL_MS));
    expect(result.current.data?.runs).toHaveLength(1);
    expect(result.current.error).toMatch(/Retrying/);

    await act(async () => void await vi.advanceTimersByTimeAsync(SAGAN_POLL_INTERVAL_MS));
    expect(result.current.data?.runs).toHaveLength(2);
    expect(result.current.error).toBeNull();

    rerender({ visible: false });
    await act(async () => void await vi.advanceTimersByTimeAsync(SAGAN_POLL_INTERVAL_MS * 2));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts the old request when the project changes", () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_input, init) => {
      signals.push((init as RequestInit).signal!);
      return new Promise(() => undefined);
    }));
    const { rerender, unmount } = renderHook(
      ({ active, list }) => useSaganCapability("tok", active, list, true),
      { initialProps: { active: thread, list: projects } },
    );
    rerender({
      active: { ...thread, projectId: "p2", cwd: "/repo/two" },
      list: [{ id: "p2", path: "/repo/two", threads: [] }] as unknown as V2ProjectWithThreads[],
    });
    expect(signals[0]?.aborted).toBe(true);
    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("auto-pins only when the queried folder is the Sagan root", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload(1, "/repo/one"),
    }));
    const { result } = renderHook(() => useSaganCapability("tok", thread, projects, false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.available).toBe(true);
    expect(result.current.autoPin).toBe(true);
  });

  it("does not auto-pin a nested folder that inherits Sagan from an ancestor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload(1, "/repo"),
    }));
    const { result } = renderHook(() => useSaganCapability("tok", thread, projects, false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.available).toBe(true);
    expect(result.current.autoPin).toBe(false);
  });

  it("re-probes on window focus even when the surface is closed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload(1) })
      .mockResolvedValueOnce({ ok: true, json: async () => payload(2) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSaganCapability("tok", thread, projects, false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.data?.runs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.runs).toHaveLength(2);
  });
});
