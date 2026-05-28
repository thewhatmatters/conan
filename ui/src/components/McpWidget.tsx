import StatusDot from "./shared/StatusDot.tsx";
import { useMcp } from "../hooks/useMcp.ts";
import FadeScroll from "./FadeScroll.tsx";

/**
 * The MCP HUD tab (US-007 v4.4, fixed): mirrors Claude's `/mcp` view as a flat
 * `name · status` list of the configured MCP servers and their live health.
 *
 * Data comes from `claude mcp list` via GET /api/claude/mcp — NOT from hooks:
 * the SessionStart hook payload carries no `mcp_servers`, so the original
 * per-session source was always empty. This list is therefore global (account/
 * install-wide), exactly like the TUI `/mcp` screen. Each row carries a
 * StatusDot whose tone maps from the status (connected→green, failed→red,
 * needs-authentication/pending→amber, other→muted). Semantic tokens only.
 */
export default function McpWidget({ token }: { token?: string | null }) {
  const { servers, loading, error, refresh } = useMcp(token ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — kept OUTSIDE the FadeScroll so the count + refresh stay
          pinned at the top while the server list below scrolls. */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          MCP servers{servers.length > 0 && ` · ${servers.length}`}
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !token}
          title="Re-check MCP server health (claude mcp list)"
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {loading ? "checking…" : "↻ refresh"}
        </button>
      </div>

      <FadeScroll>
        {servers.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            {loading
              ? "Checking MCP server health…"
              : error
                ? `Couldn't read MCP servers: ${error}`
                : "No MCP servers configured."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {servers.map((s, i) => (
              <li
                key={`${s.name}:${i}`}
                className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[12px] font-semibold text-foreground">
                    {s.name}
                  </span>
                  {s.url && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {s.url}
                      {s.transport && ` · ${s.transport}`}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <StatusDot ping={false} tone={statusTone(s.status)} />
                  <span className="text-[11px] text-muted-foreground">
                    {s.statusText || s.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </FadeScroll>
    </div>
  );
}

/** Map an MCP server status token to a StatusDot color class. */
function statusTone(status: string): string {
  switch (status) {
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
