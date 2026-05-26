import { useEffect, useState } from "react";

/** A configured/observed MCP server (mirrors the gateway's McpServerStatus). */
export interface McpServerStatus {
  name: string;
  status: "connected" | "needs-auth" | "failed";
  source: "config" | "session";
}

/** Normalized MCP status from GET /api/claude/mcp (US-003). */
export interface McpState {
  servers: McpServerStatus[];
  connectedCount: number;
  configuredCount: number;
  needsAuthCount: number;
  /** true when a live session's system/init mcp_servers overrode the inference. */
  fromLiveSession: boolean;
  /** false when nothing is configured and no live session reported any server. */
  hasData: boolean;
}

const EMPTY: McpState = {
  servers: [],
  connectedCount: 0,
  configuredCount: 0,
  needsAuthCount: 0,
  fromLiveSession: false,
  hasData: false,
};

/**
 * Loads the MCP-servers hero widget data from GET /api/claude/mcp (US-003/US-011):
 * an inferred connected count + per-server names with needs-auth flags, enriched
 * by any live session's real system/init statuses. Refetches whenever a new WS
 * event arrives (via `eventSeq`) so the count tracks live session changes.
 */
export function useMcp(eventSeq: number | null): McpState {
  const [mcp, setMcp] = useState<McpState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/mcp")
      .then((r) => r.json())
      .then((m) => {
        if (cancelled) return;
        setMcp({
          servers: Array.isArray(m.servers)
            ? m.servers.map((s: Record<string, unknown>) => ({
                name: typeof s.name === "string" ? s.name : "unknown",
                status:
                  s.status === "needs-auth" || s.status === "failed"
                    ? s.status
                    : "connected",
                source: s.source === "session" ? "session" : "config",
              }))
            : [],
          connectedCount:
            typeof m.connectedCount === "number" ? m.connectedCount : 0,
          configuredCount:
            typeof m.configuredCount === "number" ? m.configuredCount : 0,
          needsAuthCount:
            typeof m.needsAuthCount === "number" ? m.needsAuthCount : 0,
          fromLiveSession: m.fromLiveSession === true,
          hasData: m.hasData === true,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [eventSeq]);

  return mcp;
}
