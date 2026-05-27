import StatusDot from "./shared/StatusDot.tsx";
import type { WidgetData } from "../hooks/useWidgets.ts";

/**
 * The MCP HUD tab (US-007 v4.4): mirrors Claude's `/mcp` view as a flat
 * `name · status` list for the active session's MCP servers (WidgetData.mcp,
 * parsed from the session's system/init `mcp_servers`). Each row carries a
 * StatusDot whose tone maps from the server status (connected→green,
 * failed→red, needs-authentication/pending→amber, disabled/other→muted).
 *
 * A hook-only session (no system/init) has `mcp === null`; an init session with
 * no servers has `mcp === []`. Both render the same graceful empty state — we
 * never fabricate servers. Flush, panel-native rows (no card chrome) per the
 * HUD's continuous-surface direction. Tool-counts + User/claude.ai/Built-in
 * grouping are a deliberate follow-up. Semantic tokens only.
 */
export default function McpWidget({ data }: { data: WidgetData | null }) {
  const servers = data?.mcp ?? null;

  if (!servers || servers.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] text-muted-foreground">
        No MCP servers for this session.
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {servers.map((s, i) => (
        <li
          key={`${s.name}:${i}`}
          className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 last:border-b-0"
        >
          <span className="truncate text-[12px] font-semibold text-foreground">
            {s.name}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusDot ping={false} tone={statusTone(s.status)} />
            <span className="text-[11px] text-muted-foreground">
              {s.status}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Map an MCP server status string to a StatusDot color class. */
function statusTone(status: string): string {
  switch (status.toLowerCase()) {
    case "connected":
      return "bg-emerald-500";
    case "failed":
      return "bg-destructive";
    case "needs-authentication":
    case "pending":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/40";
  }
}
