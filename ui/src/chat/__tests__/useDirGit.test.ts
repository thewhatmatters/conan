/**
 * WHA-196 — useDirGit re-pulls on refreshKey (chat turn `result`) while keeping
 * the 15s interval as a backstop. Path/auth changes still clear stale status;
 * refreshKey bumps do not blank the chip.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDirGit } from "../../hooks/useDirGit.ts";

const POLL_MS = 15_000;

function gitJson(branch: string, dirty: number) {
  return {
    ok: true,
    json: async () => ({ available: true, branch, dirty }),
  };
}

describe("useDirGit (WHA-196)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pulls once on mount and again on each 15s poll (interval unchanged)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gitJson("main", 0))
      .mockResolvedValueOnce(gitJson("main", 1));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDirGit("tok", "/repo"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toEqual({ available: true, branch: "main", dirty: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current).toEqual({ available: true, branch: "main", dirty: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Not shortened: half interval must not fire another pull.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS / 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-pulls immediately when refreshKey changes (turn result)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gitJson("main", 0))
      .mockResolvedValueOnce(gitJson("feature", 2));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ key }) => useDirGit("tok", "/repo", key),
      { initialProps: { key: 0 } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.dirty).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a chat `result` landing — count of result items bumped.
    rerender({ key: 1 });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ available: true, branch: "feature", dirty: 2 });
  });

  it("does not blank current status on refreshKey bump", async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(gitJson("main", 3)), 50);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ key }) => useDirGit("tok", "/repo", key),
      { initialProps: { key: 0 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
    });
    expect(result.current?.dirty).toBe(3);

    rerender({ key: 1 });
    // Immediately after the bump, prior status must still be visible.
    expect(result.current?.dirty).toBe(3);
  });

  it("clears status when cwd changes, not when only refreshKey changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gitJson("a", 0))
      .mockResolvedValueOnce(gitJson("b", 1));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ cwd, key }) => useDirGit("tok", cwd, key),
      { initialProps: { cwd: "/repo-a", key: 0 } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.branch).toBe("a");

    rerender({ cwd: "/repo-a", key: 1 });
    // refresh only — still shows previous until new pull lands (already synced
    // above with mockResolvedValue; just assert we didn't force null mid-flight
    // by re-asserting after a microtask that resolved the second pull).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.branch).toBe("b");

    // Path change must clear first.
    fetchMock.mockResolvedValueOnce(
      new Promise(() => undefined), // hang the new pull
    );
    rerender({ cwd: "/repo-b", key: 1 });
    expect(result.current).toBeNull();
  });

  it("skips fetch when token or cwd is missing", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useDirGit(null, "/repo"));
    renderHook(() => useDirGit("tok", null));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests /api/fs/git with the encoded path and auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gitJson("main", 0));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useDirGit("secret", "/path with space"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/fs/git?path=" + encodeURIComponent("/path with space")),
      expect.objectContaining({
        headers: { "x-conan-token": "secret" },
      }),
    );
  });
});
