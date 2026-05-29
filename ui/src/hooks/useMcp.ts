import { useCallback, useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** One MCP server + health — mirrors McpServer from src/mcp/index.ts. */
export interface McpServer {
  name: string;
  url: string | null;
  transport: string | null;
  /** Normalized: connected | failed | needs-authentication | pending | <other>. */
  status: string;
  /** Raw status phrase as `claude mcp list` printed it. */
  statusText: string;
}

export interface McpState {
  servers: McpServer[];
  loading: boolean;
  /** Error message from `claude mcp list` (binary missing, timeout), or null. */
  error: string | null;
  /** When the list was captured (epoch ms), or null before the first fetch. */
  at: number | null;
}

/**
 * Loads the global MCP server list + health from GET /api/claude/mcp (v4.4),
 * which shells out to `claude mcp list`. Fetched once when the token arrives
 * (the gateway caches it 30s, so this is cheap); `refresh()` re-pulls with
 * `?force=1` to re-dial the servers on demand. Resets when there's no token.
 */
export function useMcp(token: string | null): McpState & {
  refresh: () => void;
  authenticate: (name: string) => Promise<Response>;
  reconnect: (name: string) => Promise<Response>;
} {
  const [state, setState] = useState<McpState>({
    servers: [],
    loading: false,
    error: null,
    at: null,
  });

  const load = useCallback(
    (force: boolean) => {
      if (!token) return;
      setState((s) => ({ ...s, loading: true }));
      fetch(apiBase() + "/api/claude/mcp" + (force ? "?force=1" : ""), {
        headers: { "x-conan-token": token },
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) =>
          setState({
            servers: Array.isArray(d.servers) ? d.servers : [],
            loading: false,
            error: typeof d.error === "string" ? d.error : null,
            at: typeof d.at === "number" ? d.at : Date.now(),
          }),
        )
        .catch(() =>
          setState((s) => ({ ...s, loading: false, error: "request failed" })),
        );
    },
    [token],
  );

  useEffect(() => {
    if (!token) {
      setState({ servers: [], loading: false, error: null, at: null });
      return;
    }
    load(false);
  }, [token, load]);

  // US-014: fire the token-gated one-click auth/reconnect routes (the backend
  // drives the /mcp TUI in a throwaway pty + polls for the flip to connected —
  // src/mcp/auth.ts). Both are explicit user clicks; the response (the in-flight
  // flight state) is returned to the caller, which then polls via refresh().
  const post = useCallback(
    (name: string, action: "authenticate" | "reconnect"): Promise<Response> => {
      if (!token) return Promise.reject(new Error("no token"));
      return fetch(
        apiBase() +
          `/api/claude/mcp/${encodeURIComponent(name)}/${action}`,
        { method: "POST", headers: { "x-conan-token": token } },
      );
    },
    [token],
  );

  return {
    ...state,
    refresh: () => load(true),
    authenticate: (name: string) => post(name, "authenticate"),
    reconnect: (name: string) => post(name, "reconnect"),
  };
}
