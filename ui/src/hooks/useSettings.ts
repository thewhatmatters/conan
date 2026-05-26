import { useEffect, useState } from "react";

/** Which Claude Code lifecycle hooks are wired (mirrors HooksStatus). */
export interface HooksStatus {
  installed: boolean;
  events: string[];
  source: string | null;
}

/** Remote-access (TLS) posture (mirrors the gateway's /api/settings remote). */
export interface RemoteStatus {
  tlsEnabled: boolean;
  scheme: string;
  host: string;
  loopbackOnly: boolean;
}

export interface SettingsState {
  hooks: HooksStatus;
  remote: RemoteStatus;
  loaded: boolean;
}

const EMPTY: SettingsState = {
  hooks: { installed: false, events: [], source: null },
  remote: { tlsEnabled: false, scheme: "http", host: "127.0.0.1", loopbackOnly: true },
  loaded: false,
};

/**
 * Loads the read-only Settings surface from GET /api/settings (US-020): hook
 * status + remote/TLS posture. Same-origin, so no token header is needed.
 */
export function useSettings(): SettingsState {
  const [state, setState] = useState<SettingsState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        const h = (s.hooks ?? {}) as Record<string, unknown>;
        const r = (s.remote ?? {}) as Record<string, unknown>;
        setState({
          hooks: {
            installed: h.installed === true,
            events: Array.isArray(h.events) ? (h.events as string[]) : [],
            source: typeof h.source === "string" ? h.source : null,
          },
          remote: {
            tlsEnabled: r.tlsEnabled === true,
            scheme: typeof r.scheme === "string" ? r.scheme : "http",
            host: typeof r.host === "string" ? r.host : "127.0.0.1",
            loopbackOnly: r.loopbackOnly !== false,
          },
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
