import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Which file a config value was read from — mirrors ConfigScope in src/config/index.ts. */
export type ConfigScope = "Project" | "User" | "Global";

/** One config row mirrored from Claude Code — mirrors ConfigEntry (US-007). */
export interface ConfigEntry {
  key: string;
  label: string;
  value: unknown;
  source: ConfigScope;
  sourcePath: string;
}

/** A config file the reader consulted, and whether it was present on disk. */
export interface ConfigFile {
  scope: ConfigScope;
  path: string;
  present: boolean;
}

/** Shape of GET /api/claude/config (US-007). */
export interface ClaudeConfig {
  entries: ConfigEntry[];
  files: ConfigFile[];
}

/**
 * Loads Claude Code's read-only config mirror from the token-gated
 * GET /api/claude/config (US-007). Like useSkills this is fetched once when the
 * token first arrives — the on-disk settings don't change at runtime within a
 * session, and the Settings view re-mounts (re-fetches) each time it's opened.
 * Resets to null when there's no token.
 */
export function useConfig(token: string | null): ClaudeConfig | null {
  const [config, setConfig] = useState<ClaudeConfig | null>(null);

  useEffect(() => {
    if (!token) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    fetch(apiBase() + "/api/claude/config", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && Array.isArray(d.entries)) setConfig(d as ClaudeConfig);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  return config;
}
