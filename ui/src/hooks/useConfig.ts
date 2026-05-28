import { useCallback, useEffect, useState } from "react";
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

/** How a config value is typed — mirrors ConfigKind in src/config/index.ts. */
export type ConfigKind = "boolean" | "enum" | "string" | "number";

/**
 * Type metadata for one editable key — mirrors KeyType in src/config/index.ts
 * (US-002). Drives the control the Config tab renders (read-only here in US-009,
 * interactive in US-010). Enum `values` are extracted from the claude binary.
 */
export interface KeyType {
  key: string;
  label: string;
  kind: ConfigKind;
  scope: "settings" | "global";
  values?: string[];
}

/** Shape of GET /api/claude/config (US-007 + US-002 `schema`). */
export interface ClaudeConfig {
  entries: ConfigEntry[];
  files: ConfigFile[];
  schema: KeyType[];
}

/**
 * Loads Claude Code's config mirror from the token-gated GET /api/claude/config
 * (US-007). Fetched when the token first arrives — the on-disk settings don't
 * change at runtime within a session. The returned `refetch` re-reads from disk
 * after the Config tab writes a key (US-010) so the saved value is reflected and
 * persists across reopen. Resets to null when there's no token.
 */
export function useConfig(token: string | null): [ClaudeConfig | null, () => void] {
  const [config, setConfig] = useState<ClaudeConfig | null>(null);

  const refetch = useCallback(() => {
    if (!token) {
      setConfig(null);
      return;
    }
    fetch(apiBase() + "/api/claude/config", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.entries)) {
          setConfig({ ...d, schema: Array.isArray(d.schema) ? d.schema : [] } as ClaudeConfig);
        }
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return [config, refetch];
}
