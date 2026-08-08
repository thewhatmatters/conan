import { useEffect, useMemo, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";
import type { SaganRunsResult } from "../../../../src/sagan/api.ts";
import type { ActiveThread } from "./types.ts";
import type { V2ProjectWithThreads } from "./useV2Projects.ts";

export interface SaganCapabilityResult {
  available: boolean;
  projectPath: string | null;
  status: "idle" | "loading" | "ready" | "error";
  data: SaganRunsResult | null;
  error: string | null;
}

/** Detect Sagan through the existing project-scoped runs endpoint. */
export function useSaganCapability(
  token: string | null,
  activeThread: ActiveThread | null,
  projects: V2ProjectWithThreads[],
): SaganCapabilityResult {
  const projectPath = useMemo(() => {
    const project = activeThread?.projectId
      ? projects.find((candidate) => candidate.id === activeThread.projectId)
      : null;
    return project?.path ?? activeThread?.cwd ?? null;
  }, [activeThread?.cwd, activeThread?.projectId, projects]);
  const [result, setResult] = useState<{
    path: string;
    status: "loading" | "ready" | "error";
    data: SaganRunsResult | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!token || !projectPath) return;
    const controller = new AbortController();
    setResult({ path: projectPath, status: "loading", data: null, error: null });
    void (async () => {
      try {
        const response = await fetch(
          apiBase() + `/api/sagan/runs?projectId=${encodeURIComponent(projectPath)}`,
          {
            headers: { "x-conan-token": token },
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as SaganRunsResult;
        if (!controller.signal.aborted) {
          setResult({ path: projectPath, status: "ready", data, error: null });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult({
            path: projectPath,
            status: "error",
            data: null,
            error: "Sagan runs could not be loaded.",
          });
        }
      }
    })();
    return () => controller.abort();
  }, [projectPath, token]);

  const current = result?.path === projectPath ? result : null;
  const saganState = current?.data?.project?.sagan.state;
  return {
    // Keep malformed/unsupported overlays reachable so the surface can explain
    // what needs fixing instead of disappearing like an absent project.
    available:
      (saganState != null && saganState !== "absent") || current?.status === "error",
    projectPath,
    status: !token || !projectPath ? "idle" : current?.status ?? "loading",
    data: current?.data ?? null,
    error: current?.error ?? null,
  };
}
