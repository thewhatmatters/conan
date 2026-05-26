import { useCallback, useEffect, useState } from "react";

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

// ---------------------------------------------------------------------------
// US-029: Claude Code settings mirror (typed controls + safe write).

export type SettingType = "boolean" | "enum" | "string" | "integer";

/** One Claude Code setting (mirrors the gateway's SettingValue). */
export interface ClaudeSetting {
  key: string;
  value: unknown;
  type: SettingType;
  allowed?: string[];
  min?: number;
  max?: number;
  default: unknown;
  writable: boolean;
  defSource: "schema" | "builtin";
  description?: string;
  /** Basename of the file the value came from, or "default" when unset. */
  source: string;
}

export interface ClaudeSettingsState {
  settings: ClaudeSetting[];
  /** Resolved file paths the values are read from. */
  sources: { settings: string; local: string; claudeJson: string };
  /** True until the first fetch settles. */
  loaded: boolean;
}

const EMPTY_CLAUDE: ClaudeSettingsState = {
  settings: [],
  sources: { settings: "", local: "", claudeJson: "" },
  loaded: false,
};

function normalizeSetting(s: Record<string, unknown>): ClaudeSetting {
  return {
    key: String(s.key ?? ""),
    value: s.value,
    type: (s.type as SettingType) ?? "string",
    allowed: Array.isArray(s.allowed) ? (s.allowed as string[]) : undefined,
    min: typeof s.min === "number" ? s.min : undefined,
    max: typeof s.max === "number" ? s.max : undefined,
    default: s.default,
    writable: s.writable === true,
    defSource: s.defSource === "builtin" ? "builtin" : "schema",
    description: typeof s.description === "string" ? s.description : undefined,
    source: typeof s.source === "string" ? s.source : "default",
  };
}

/** Result of a safe-write attempt. */
export interface WriteOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Loads the real Claude Code settings from GET /api/claude/settings (US-006)
 * and exposes a token-gated `write(key, value)` that persists one allowlisted
 * preference key via PUT /api/claude/settings, then folds the confirmed value
 * back into local state (optimistic-with-rollback handled by the caller).
 */
export function useClaudeSettings(token: string | null): {
  state: ClaudeSettingsState;
  write: (key: string, value: unknown) => Promise<WriteOutcome>;
  /** Locally override one setting's value (for optimistic UI / rollback). */
  setLocal: (key: string, value: unknown, source?: string) => void;
} {
  const [state, setState] = useState<ClaudeSettingsState>(EMPTY_CLAUDE);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/settings")
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        const list = Array.isArray(s.settings)
          ? (s.settings as Record<string, unknown>[]).map(normalizeSetting)
          : [];
        const src = (s.sources ?? {}) as Record<string, unknown>;
        setState({
          settings: list,
          sources: {
            settings: typeof src.settings === "string" ? src.settings : "",
            local: typeof src.local === "string" ? src.local : "",
            claudeJson: typeof src.claudeJson === "string" ? src.claudeJson : "",
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

  const setLocal = useCallback(
    (key: string, value: unknown, source?: string) => {
      setState((s) => ({
        ...s,
        settings: s.settings.map((it) =>
          it.key === key
            ? { ...it, value, source: source ?? it.source }
            : it,
        ),
      }));
    },
    [],
  );

  const write = useCallback(
    async (key: string, value: unknown): Promise<WriteOutcome> => {
      try {
        const res = await fetch("/api/claude/settings", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(token ? { "x-conan-token": token } : {}),
          },
          body: JSON.stringify({ key, value }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          return { ok: false, error: String(body.error ?? `write failed (${res.status})`) };
        }
        // Reflect the server-confirmed (post-coercion) value + new source file.
        setLocal(key, body.value, "settings.json");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    [token, setLocal],
  );

  return { state, write, setLocal };
}
