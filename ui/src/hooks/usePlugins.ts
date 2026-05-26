import { useEffect, useState } from "react";

/** One installed plugin (mirrors the gateway's InstalledPlugin, US-011). */
export interface InstalledPlugin {
  /** "<name>@<marketplace>" key. */
  id: string;
  name: string;
  marketplace: string;
  scope: string;
  version: string | null;
  gitCommitSha: string | null;
  installPath: string | null;
  /** Set for project-scoped installs. */
  projectPath: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  enabled: boolean;
}

/** One known marketplace (mirrors the gateway's Marketplace, US-011). */
export interface Marketplace {
  name: string;
  sourceType: string | null;
  sourceUrl: string | null;
  installLocation: string | null;
  lastUpdated: string | null;
}

export interface PluginsState {
  plugins: InstalledPlugin[];
  marketplaces: Marketplace[];
  /** True until the first fetch settles. */
  loaded: boolean;
}

/**
 * Loads installed plugins + known marketplaces (US-032) from
 * GET /api/claude/plugins (US-011): the plugins on this machine — name,
 * version, scope, enabled flag, and originating marketplace — plus the
 * marketplaces they came from. Read-only. Refetches on each new WS event so a
 * freshly-installed plugin surfaces; missing/malformed files degrade to empty
 * arrays on the gateway side.
 */
export function usePlugins(eventSeq: number | null): PluginsState {
  const [state, setState] = useState<PluginsState>({
    plugins: [],
    marketplaces: [],
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/plugins")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setState({
          plugins: Array.isArray(d?.plugins)
            ? (d.plugins as InstalledPlugin[])
            : [],
          marketplaces: Array.isArray(d?.marketplaces)
            ? (d.marketplaces as Marketplace[])
            : [],
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled)
          setState({ plugins: [], marketplaces: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [eventSeq]);

  return state;
}
