import { useMemo, useState } from "react";
import {
  usePlugins,
  type InstalledPlugin,
  type Marketplace,
} from "../hooks/usePlugins.ts";
import { Badge } from "./ui/badge.tsx";

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Short, human form of a version (drops long commit-sha "versions"). */
function fmtVersion(v: string | null): string | null {
  if (!v) return null;
  if (v === "unknown") return null;
  // Long hex strings are commit shas masquerading as a version — abbreviate.
  if (/^[0-9a-f]{12,}$/i.test(v)) return v.slice(0, 7);
  return v;
}

/**
 * Plugins panel (US-032). Renders the US-011 data from GET /api/claude/plugins:
 * the installed plugins on this machine (name, version, scope, enabled flag,
 * originating marketplace) and the marketplaces they were installed from.
 * Read-only — install/enable happens in Claude Code, not here.
 *
 * shadcn primitives + semantic tokens (light/dark follow the theme); loading
 * and empty states throughout.
 */
export default function PluginsView({ trigger = 0 }: { trigger?: number }) {
  const { plugins, marketplaces, loaded } = usePlugins(trigger);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filteredPlugins = useMemo(
    () =>
      !q
        ? plugins
        : plugins.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.marketplace.toLowerCase().includes(q) ||
              p.scope.toLowerCase().includes(q),
          ),
    [plugins, q],
  );
  const filteredMarkets = useMemo(
    () =>
      !q
        ? marketplaces
        : marketplaces.filter(
            (m) =>
              m.name.toLowerCase().includes(q) ||
              (m.sourceUrl ?? "").toLowerCase().includes(q),
          ),
    [marketplaces, q],
  );

  const enabledCount = useMemo(
    () => plugins.filter((p) => p.enabled).length,
    [plugins],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold tracking-tight">Plugins</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Claude Code plugins installed on this machine and the marketplaces they
        came from — read from{" "}
        <code className="font-mono">~/.claude/plugins</code>.
      </p>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
        <PlugIcon />
        <span>
          <span className="font-medium text-foreground">Read-only.</span>{" "}
          Install, update, or enable plugins in Claude Code with{" "}
          <code className="font-mono">/plugin</code>; this view reflects what's
          on disk.
        </span>
      </div>

      {!loaded ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : plugins.length === 0 && marketplaces.length === 0 ? (
        <Empty>
          No plugins installed. Add a marketplace and install plugins in Claude
          Code with <code className="font-mono">/plugin</code> — they'll appear
          here.
        </Empty>
      ) : (
        <>
          <div className="mt-5 flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <SearchIcon />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                placeholder="Filter plugins and marketplaces…"
                className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {plugins.length} plugin{plugins.length === 1 ? "" : "s"} ·{" "}
              {enabledCount} enabled · {marketplaces.length} marketplace
              {marketplaces.length === 1 ? "" : "s"}
            </span>
          </div>

          {/* Installed plugins */}
          <section className="mt-5">
            <h2 className="mb-2 text-sm font-medium text-foreground">
              Installed plugins
            </h2>
            {plugins.length === 0 ? (
              <Empty>No plugins installed.</Empty>
            ) : filteredPlugins.length === 0 ? (
              <Empty>No plugins match your filter.</Empty>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2">
                {filteredPlugins.map((p) => (
                  <PluginCard key={`${p.id}:${p.scope}`} plugin={p} />
                ))}
              </div>
            )}
          </section>

          {/* Known marketplaces */}
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-medium text-foreground">
              Marketplaces
            </h2>
            {marketplaces.length === 0 ? (
              <Empty>No marketplaces configured.</Empty>
            ) : filteredMarkets.length === 0 ? (
              <Empty>No marketplaces match your filter.</Empty>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2">
                {filteredMarkets.map((m) => (
                  <MarketplaceCard key={m.name} market={m} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PluginCard({ plugin }: { plugin: InstalledPlugin }) {
  const version = fmtVersion(plugin.version);
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {plugin.name}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            from {plugin.marketplace || "—"}
          </span>
        </div>
        <Badge variant={plugin.enabled ? "default" : "secondary"}>
          {plugin.enabled ? "enabled" : "disabled"}
        </Badge>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="capitalize">
          {plugin.scope}
        </Badge>
        {version && (
          <Badge variant="outline" className="font-mono font-normal">
            v{version}
          </Badge>
        )}
        {plugin.gitCommitSha && (
          <Badge
            variant="outline"
            className="font-mono font-normal"
            title={plugin.gitCommitSha}
          >
            {plugin.gitCommitSha.slice(0, 7)}
          </Badge>
        )}
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Updated {fmtTime(plugin.lastUpdated)}
      </div>
    </div>
  );
}

function MarketplaceCard({ market }: { market: Marketplace }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {market.name}
        </span>
        {market.sourceType && (
          <Badge variant="outline" className="shrink-0 capitalize">
            {market.sourceType}
          </Badge>
        )}
      </div>
      {market.sourceUrl && (
        <span
          className="mt-1 block truncate font-mono text-[11px] text-muted-foreground"
          title={market.sourceUrl}
        >
          {market.sourceUrl}
        </span>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">
        Updated {fmtTime(market.lastUpdated)}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-muted-foreground"
    >
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v5" />
    </svg>
  );
}
