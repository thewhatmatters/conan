import { useEffect, useMemo, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";
import type { SaganRunsResult } from "../../../../src/sagan/api.ts";
import type { ActiveThread } from "./types.ts";
import type { V2ProjectWithThreads } from "./useV2Projects.ts";

interface CapabilityResult {
  available: boolean;
  projectPath: string | null;
}

/** Detect Sagan through the existing project-scoped runs endpoint. */
export function useSaganCapability(
  token: string | null,
  activeThread: ActiveThread | null,
  projects: V2ProjectWithThreads[],
): CapabilityResult {
  const projectPath = useMemo(() => {
    const project = activeThread?.projectId
      ? projects.find((candidate) => candidate.id === activeThread.projectId)
      : null;
    return project?.path ?? activeThread?.cwd ?? null;
  }, [activeThread?.cwd, activeThread?.projectId, projects]);
  const [result, setResult] = useState<{ path: string; available: boolean } | null>(null);

  useEffect(() => {
    if (!token || !projectPath) return;
    const controller = new AbortController();
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
          setResult({
            path: projectPath,
            available: data.project?.sagan.state === "valid",
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult({ path: projectPath, available: false });
        }
      }
    })();
    return () => controller.abort();
  }, [projectPath, token]);

  return {
    available: result?.path === projectPath && result.available,
    projectPath,
  };
}
