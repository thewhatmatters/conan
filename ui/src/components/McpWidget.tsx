import { useEffect, useState } from "react";
import StatusDot from "./shared/StatusDot.tsx";
import { useMcp } from "../hooks/useMcp.ts";
import FadeScroll from "./FadeScroll.tsx";
import HudTabHeader from "./shared/HudTabHeader.tsx";

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
  const { servers, loading, error, refresh, authenticate, reconnect } = useMcp(
    token ?? null,
  );

  // US-014: per-row in-flight state for a one-click Authenticate / Reconnect.
  // Keyed by server name; carries which action fired + when it started so the
  // poll-and-clear logic below can bound the spinner. The backend drives the
  // auth out-of-band (browser consent) and polls for the flip to connected, so
  // we poll the MCP list via refresh() until the row repaints connected.
  const [busy, setBusy] = useState<
    Record<string, { action: "authenticate" | "reconnect"; startedAt: number }>
  >({});

  // While any row is in-flight, re-pull the MCP list on an interval (so a row
  // flips to connected once auth completes) and time out a stuck spinner.
  useEffect(() => {
    if (Object.keys(busy).length === 0) return;
    const id = setInterval(() => {
      refresh();
      setBusy((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [name, info] of Object.entries(prev)) {
          if (Date.now() - info.startedAt > 90_000) {
            delete next[name];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 3_000);
    return () => clearInterval(id);
  }, [busy, refresh]);

  // Clear a row's in-flight state the moment its server reports connected.
  useEffect(() => {
    setBusy((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const name of Object.keys(prev)) {
        const s = servers.find((x) => x.name === name);
        if (s && s.status === "connected") {
          delete next[name];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [servers]);

  const fire = (name: string, action: "authenticate" | "reconnect") => {
    setBusy((prev) => ({ ...prev, [name]: { action, startedAt: Date.now() } }));
    const call = action === "authenticate" ? authenticate : reconnect;
    void call(name)
      .then(() => refresh())
      .catch(() => {
        // Drop the spinner on a failed kickoff so the action stays clickable.
        setBusy((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — rides the shared <HudTabHeader> (pinned outside the FadeScroll
          so the count + refresh stay put while the server list below scrolls),
          unifying its chrome with the Skills / Pulse / Usage tabs. */}
      <HudTabHeader
        name={
          <span className="px-1 text-[11px] font-medium text-muted-foreground">
            MCP servers{servers.length > 0 && ` · ${servers.length}`}
          </span>
        }
        actions={
          <button
            type="button"
            onClick={refresh}
            disabled={loading || !token}
            title="Re-check MCP server health (claude mcp list)"
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {loading ? "checking…" : "↻ refresh"}
          </button>
        }
      />

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
                  <RowAction
                    status={s.status}
                    busy={busy[s.name]?.action ?? null}
                    onAuthenticate={() => fire(s.name, "authenticate")}
                    onReconnect={() => fire(s.name, "reconnect")}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </FadeScroll>
    </div>
  );
}

/**
 * The inline row action (US-014). `needs-authentication` rows offer
 * Authenticate (an explicit user click — it opens the browser for OAuth
 * consent), `failed` rows offer Reconnect (re-checks health; it can't fix a
 * server that's down). `connected` rows show nothing. While in-flight the
 * button is replaced by a busy label. Styling mirrors the ↻ refresh button.
 */
function RowAction({
  status,
  busy,
  onAuthenticate,
  onReconnect,
}: {
  status: string;
  busy: "authenticate" | "reconnect" | null;
  onAuthenticate: () => void;
  onReconnect: () => void;
}) {
  if (busy) {
    return (
      <span className="text-[10px] font-medium text-muted-foreground">
        {busy === "authenticate" ? "authenticating…" : "reconnecting…"}
      </span>
    );
  }
  if (status === "needs-authentication") {
    return (
      <button
        type="button"
        onClick={onAuthenticate}
        title="Authenticate this server — opens your browser for OAuth consent"
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
      >
        Authenticate
      </button>
    );
  }
  if (status === "failed") {
    return (
      <button
        type="button"
        onClick={onReconnect}
        title="Re-check this server's health — won't fix a server that's down"
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
      >
        Reconnect
      </button>
    );
  }
  return null;
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
