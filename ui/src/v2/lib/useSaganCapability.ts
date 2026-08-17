import { useEffect, useMemo, useRef, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";
import type { SaganRunsResult } from "../../../../src/sagan/api.ts";
import type { ActiveThread } from "./types.ts";
import type { V2ProjectWithThreads } from "./useV2Projects.ts";

export interface SaganCapabilityResult {
  available: boolean;
  /** True only when the queried folder IS the Sagan root, not a nested child. */
  autoPin: boolean;
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
  // Holds the latest refresh closure so a window-focus re-probe can run against
  // the current token/projectPath even when the Sagan surface is closed.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // Serializes overlapping fetches (visible poll + a focus re-probe) so the
  // latest result wins instead of two in-flight requests racing setResult.
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token || !projectPath) {
      refreshRef.current = async () => {};
      return;
    }
    const requestKey = `${token}\0${projectPath}`;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      try {
        const response = await fetch(
          apiBase() + `/api/sagan/runs?projectId=${encodeURIComponent(projectPath)}`,
          {
            headers: { "x-conan-token": token },
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        if (inFlightRef.current !== controller) return;
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as SaganRunsResult;
        setResult({ path: projectPath, status: "ready", data, error: null, updatedAt: Date.now() });
      } catch {
        if (controller.signal.aborted) return;
        if (inFlightRef.current !== controller) return;
        setResult((current) => ({
          path: projectPath,
          status: current?.path === projectPath && current.data ? "ready" : "error",
          data: current?.path === projectPath ? current.data : null,
          error: current?.path === projectPath && current.data
            ? "Sagan runs could not be refreshed. Retrying…"
            : "Sagan runs could not be loaded. Retrying…",
          updatedAt: current?.path === projectPath ? current.updatedAt : null,
        }));
      } finally {
        if (inFlightRef.current === controller) inFlightRef.current = null;
        if (visible && !controller.signal.aborted) {
          timeout = setTimeout(refresh, SAGAN_POLL_INTERVAL_MS);
        }
      }
    };

    // Always publish the latest refresh closure so focus re-probes use the
    // current token/projectPath, even when we return early below.
    refreshRef.current = refresh;

    if (!visible && requestedKeyRef.current === requestKey) return;
    requestedKeyRef.current = requestKey;
    setResult((current) => current?.path === projectPath
      ? current
      : { path: projectPath, status: "loading", data: null, error: null, updatedAt: null });
    void refresh();

    return () => {
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      if (timeout) clearTimeout(timeout);
    };
  }, [projectPath, token, visible]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshRef.current();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  const current = result?.path === projectPath ? result : null;
  const saganState = current?.data?.project?.sagan.state;
  const isOwnRoot = current?.data?.project?.root === projectPath;
  const hasOverlay = saganState != null && saganState !== "absent";
  return {
    // Keep malformed/unsupported overlays reachable so the surface can explain
    // what needs fixing instead of disappearing like an absent project.
    available: hasOverlay || current?.status === "error",
    // Auto-pin only promotes tabs for folders that are themselves the Sagan
    // root. Nested folders can still open Sagan manually and see ancestor runs.
    autoPin: hasOverlay && isOwnRoot,
    projectPath,
    status: !token || !projectPath ? "idle" : current?.status ?? "loading",
    data: current?.data ?? null,
    error: current?.error ?? null,
    updatedAt: current?.updatedAt ?? null,
  };
}
