/**
 * useV2Projects — the sidebar's read model (p2d US-501).
 *
 * The assertions that matter here are the ones about state that ISN'T the
 * happy path: no token means no fetch (the socket isn't authed yet), and a
 * failed fetch must be distinguishable from an empty account — otherwise the
 * tree renders "No projects yet" over a gateway that simply wasn't up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useV2Projects } from "../lib/useV2Projects.ts";

const PROJECTS = [
  {
    id: "p1",
    path: "/repo/conan",
    name: "conan",
    createdAt: 1,
    repoRoot: "/repo/conan",
    threads: [
      {
        sessionId: "s1",
        cwd: "/repo/conan",
        model: "opus",
        provider: "claude",
        effort: "think",
        title: "Analyze my project",
        lastMessage: "Run serverless code...",
        createdAt: 1,
        lastActivity: 9,
      },
    ],
  },
];

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(impl(String(input))),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useV2Projects", () => {
  it("does not touch the gateway without a token", () => {
    const fetchMock = mockFetch(() => ok({ projects: [] }));

    const { result } = renderHook(() => useV2Projects(null));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.projects).toEqual([]);
    // Crucially NOT loaded — the tree must say "loading", not "no projects".
    expect(result.current.loaded).toBe(false);
  });

  it("fetches projects with their threads and the auth header", async () => {
    const fetchMock = mockFetch(() => ok({ projects: PROJECTS }));

    const { result } = renderHook(() => useV2Projects("tok"));

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0]?.threads[0]?.sessionId).toBe("s1");
    expect(result.current.error).toBe(false);

    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain("/api/agent/projects");
    expect(
      (call?.[1]?.headers as Record<string, string> | undefined)?.["x-conan-token"],
    ).toBe("tok");
  });

  it("defaults a project with no threads array to an empty list", async () => {
    mockFetch(() => ok({ projects: [{ id: "p2", path: "/x", name: "x", createdAt: 0 }] }));

    const { result } = renderHook(() => useV2Projects("tok"));

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.projects[0]?.threads).toEqual([]);
  });

  it("reports an unreachable gateway as error, not as an empty account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    const { result } = renderHook(() => useV2Projects("tok"));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.projects).toEqual([]);
  });

  it("re-pulls the list on refresh", async () => {
    let payload = { projects: PROJECTS };
    const fetchMock = mockFetch(() => ok(payload));

    const { result } = renderHook(() => useV2Projects("tok"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    payload = { projects: [] };
    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.projects).toEqual([]);
  });
});
