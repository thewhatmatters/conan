import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Where an agent came from — mirrors AgentSource in src/agents/index.ts. */
export type AgentSource = "User" | "Project" | "Plugin";

/** One installed agent — mirrors AgentEntry from GET /api/claude/agents. */
export interface AgentEntry {
  name: string;
  /** Frontmatter description, or null when none is readable (never fabricated). */
  description: string | null;
  source: AgentSource;
  /** Plugin key when source === "Plugin". */
  plugin?: string;
  /** The agent's on-disk `.md` file, home-relative (`~/…`). */
  path?: string;
  /** Raw frontmatter `tools:` value (comma-separated list), or null. */
  tools?: string | null;
  /** Raw frontmatter `model:` value, or null. */
  model?: string | null;
}

/**
 * Loads the installed agents (name + description + source) from the token-gated
 * GET /api/claude/agents. Like useSkills, agent `.md` files are static for a
 * session — fetched once when the token first arrives and cached for the
 * panel's lifetime. Resets to empty when there's no token.
 */
export function useAgents(token: string | null): AgentEntry[] {
  const [agents, setAgents] = useState<AgentEntry[]>([]);

  useEffect(() => {
    if (!token) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    fetch(apiBase() + "/api/claude/agents", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && Array.isArray(d)) setAgents(d as AgentEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  return agents;
}
