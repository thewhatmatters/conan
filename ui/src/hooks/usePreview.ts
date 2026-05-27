import { useCallback, useEffect, useRef, useState } from "react";

/** Run state of the (single) preview dev server, mirroring src/preview. */
export type PreviewRunState =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "error";

export interface PreviewStatus {
  active: boolean;
  id: string | null;
  state: PreviewRunState;
  cwd: string | null;
  script: string | null;
  command: string | null;
  port: number | null;
  vite: boolean;
  exitCode: number | null;
  error: string | null;
}

/** A discovered candidate dev command from the cwd's package.json scripts. */
export interface PreviewCandidate {
  script: string;
  command: string;
  vite: boolean;
}

export interface PreviewDiscovery {
  cwd: string;
  candidates: PreviewCandidate[];
  defaultScript: string | null;
  error?: string;
}

export interface PreviewHook {
  status: PreviewStatus | null;
  discovery: PreviewDiscovery | null;
  /** Recent dev-server stdout/stderr (the ring-buffer tail). */
  log: string;
  /** True while a start/stop request is in flight. */
  busy: boolean;
  /** Last action error (start failed / not authed), cleared on the next action. */
  actionError: string | null;
  start: (script?: string) => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => void;
}

/**
 * Drives the live-preview backend (US-010/011) for the Preview dock tab (US-012):
 * reads GET /api/preview/status for the discovered dev commands + run state,
 * POSTs /start and /stop (token-gated), and tails GET /api/preview/log for the
 * honest output pane. Polls fast while the server is starting (the bound port /
 * id needed for the iframe arrive then) and slowly once it is up, so the iframe
 * mounts as soon as the proxy target is live. Re-discovers on cwd change since
 * the candidate scripts are cwd-scoped (the backend also stops a preview that
 * belonged to the previous cwd, so the status flips to idle/exited on its own).
 */
export function usePreview(token: string | null, cwd: string | null): PreviewHook {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [discovery, setDiscovery] = useState<PreviewDiscovery | null>(null);
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Bump to force an immediate refetch (after start/stop, or on demand).
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const aliveRef = useRef(true);

  // Status + log polling. Cadence follows run state: fast (1.5s) while starting
  // so the iframe mounts the moment the port is known, slow (5s) once running or
  // idle. cwd in the deps re-discovers when the toolbar switches projects.
  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const r = await fetch("/api/preview/status");
        const j = (await r.json()) as {
          status: PreviewStatus;
          discovery: PreviewDiscovery;
        };
        if (!aliveRef.current) return;
        setStatus(j.status);
        setDiscovery(j.discovery);
        // Only tail the log when there is (or was) a process to talk about.
        if (j.status.state !== "idle") {
          const lr = await fetch("/api/preview/log");
          const lj = (await lr.json()) as { output?: string };
          if (aliveRef.current) setLog(lj.output ?? "");
        } else if (aliveRef.current) {
          setLog("");
        }
        const fast = j.status.state === "starting";
        timer = setTimeout(poll, fast ? 1500 : 5000);
      } catch {
        if (aliveRef.current) timer = setTimeout(poll, 5000);
      }
    };
    poll();

    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick, cwd]);

  const start = useCallback(
    async (script?: string) => {
      if (!token) {
        setActionError("not authenticated");
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        const r = await fetch("/api/preview/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-conan-token": token },
          body: JSON.stringify(script ? { script } : {}),
        });
        const j = (await r.json()) as { ok?: boolean; status?: PreviewStatus; error?: string };
        if (!r.ok || !j.ok) {
          setActionError(j.error ?? "could not start preview");
        } else if (j.status) {
          setStatus(j.status);
        }
      } catch (e) {
        setActionError((e as Error).message);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [token, refresh],
  );

  const stop = useCallback(async () => {
    if (!token) {
      setActionError("not authenticated");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch("/api/preview/stop", {
        method: "POST",
        headers: { "x-conan-token": token },
      });
      const j = (await r.json()) as { status?: PreviewStatus };
      if (j.status) setStatus(j.status);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  }, [token, refresh]);

  return { status, discovery, log, busy, actionError, start, stop, refresh };
}
