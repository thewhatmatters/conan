import { useEffect, useMemo, useRef, useState } from "react";
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
  updatedAt: number | null;
}

export const SAGAN_POLL_INTERVAL_MS = 7_500;

/** Detect Sagan through the existing project-scoped runs endpoint. */
export function useSaganCapability(
  token: string | null,
  activeThread: ActiveThread | null,
  projects: V2ProjectWithThreads[],
  visible = false,
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
    updatedAt: number | null;
  } | null>(null);
  const requestedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!token || !projectPath) return;
    const requestKey = `${token}\0${projectPath}`;
    if (!visible && requestedKeyRef.current === requestKey) return;
    requestedKeyRef.current = requestKey;
    const controller = new AbortController();
    setResult((current) => current?.path === projectPath
      ? current
      : { path: projectPath, status: "loading", data: null, error: null, updatedAt: null });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
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
          setResult({ path: projectPath, status: "ready", data, error: null, updatedAt: Date.now() });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult((current) => ({
            path: projectPath,
            status: current?.path === projectPath && current.data ? "ready" : "error",
            data: current?.path === projectPath ? current.data : null,
            error: current?.path === projectPath && current.data
              ? "Sagan runs could not be refreshed. Retrying…"
              : "Sagan runs could not be loaded. Retrying…",
            updatedAt: current?.path === projectPath ? current.updatedAt : null,
          }));
        }
      } finally {
        if (visible && !controller.signal.aborted) {
          timeout = setTimeout(refresh, SAGAN_POLL_INTERVAL_MS);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [projectPath, token, visible]);

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
    updatedAt: current?.updatedAt ?? null,
  };
}
