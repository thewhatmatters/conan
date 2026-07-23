import { useCallback, useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Result shape of GET /api/claude/hooks — mirrors src/hooks/install.ts. */
export interface GlobalHooksState {
  /** True iff every observed lifecycle event forwards to send-event.mjs.
   *  `null` while the first fetch is in flight (or the gateway is down) so
   *  the onboarding gate can show a spinner instead of a wrong verdict. */
  installed: boolean | null;
  /** Events an install would still add (empty when installed). */
  missing: string[];
  /** Where the settings live — surfaced in the onboarding detail line. */
  path: string | null;
  /** In-flight flag for the one-click install POST. */
  installing: boolean;
  /** Install failure (or status-fetch failure) message, if any. */
  error: string | null;
  /** POST /api/claude/hooks/install, then refresh the status. */
  install: () => void;
}

/**
 * Global-hook install status for the onboarding hard-gate (US-023). The chat
 * shell has no terminal fallback and the activity spine/skills ride the hook
 * events, so first-run checks this alongside the claude install probe and
 * offers the one-click installer.
 */
export function useGlobalHooks(token: string | null): GlobalHooksState {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((d: unknown) => {
    const s = d as { installed?: unknown; missing?: unknown; path?: unknown };
    setInstalled(typeof s?.installed === "boolean" ? s.installed : null);
    setMissing(
      Array.isArray(s?.missing) ? s.missing.filter((m) => typeof m === "string") : [],
    );
    setPath(typeof s?.path === "string" ? s.path : null);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiBase() + "/api/claude/hooks", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) applyStatus(d);
      })
      .catch(() => {
        // Gateway unreachable — stay `null` (checking) rather than claiming
        // hooks are missing when we simply couldn't ask.
      });
    return () => {
      cancelled = true;
    };
  }, [token, applyStatus]);

  const install = useCallback(() => {
    if (!token || installing) return;
    setInstalling(true);
    setError(null);
    fetch(apiBase() + "/api/claude/hooks/install", {
      method: "POST",
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => applyStatus(d?.status ?? d))
      .catch((e) => setError(e instanceof Error ? e.message : "install failed"))
      .finally(() => setInstalling(false));
  }, [token, installing, applyStatus]);

  return { installed, missing, path, installing, error, install };
}
