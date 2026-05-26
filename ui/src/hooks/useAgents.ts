import { useCallback, useEffect, useState } from "react";

/** One custom agent definition (mirrors the gateway's CustomAgent). */
export interface CustomAgent {
  name: string;
  description: string | null;
  role: string | null;
  scope: "user" | "project";
  tools: string[] | null;
  source: string;
}

/** One live background-agent session (mirrors the gateway's BackgroundAgent). */
export interface BackgroundAgent {
  pid: number | null;
  cwd: string | null;
  kind: string | null;
  sessionId: string | null;
  startedAt: number | null;
  status: string | null;
}

export interface AgentsState {
  /** Custom-agents registry from ~/.claude/agents + project (US-012). */
  custom: CustomAgent[];
  /** Live background agents from `claude agents --json` (US-013). */
  background: BackgroundAgent[];
  /** True once the background-agents CLI ran and produced a parseable list. */
  backgroundAvailable: boolean;
  /** Short reason the background list is unavailable; null on success. */
  backgroundError: string | null;
  /** True until the first fetch of each source settles. */
  loaded: boolean;
}

const EMPTY: AgentsState = {
  custom: [],
  background: [],
  backgroundAvailable: false,
  backgroundError: null,
  loaded: false,
};

/**
 * Loads the Agents page data (US-027): the custom-agents registry from the
 * same-origin GET /api/claude/agents (US-012) and the live background agents
 * from the token-gated GET /api/claude/background-agents (US-013). Re-pulls on
 * `trigger` (e.g. each WS event) so the live list stays fresh, and exposes a
 * manual `refresh`. Both sources degrade independently — a missing token leaves
 * the background list empty/unavailable without breaking the registry.
 */
export function useAgents(
  token: string | null,
  trigger: number,
): AgentsState & { refresh: () => void } {
  const [state, setState] = useState<AgentsState>(EMPTY);

  const load = useCallback(() => {
    let cancelled = false;

    const customP = fetch("/api/claude/agents")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d?.agents) ? (d.agents as CustomAgent[]) : []))
      .catch(() => [] as CustomAgent[]);

    const bgP = token
      ? fetch("/api/claude/background-agents", {
          headers: { "x-conan-token": token },
        })
          .then((r) => r.json())
          .catch(() => ({ agents: [], available: false, error: "fetch failed" }))
      : Promise.resolve({
          agents: [],
          available: false,
          error: "no token",
        });

    Promise.all([customP, bgP]).then(([custom, bg]) => {
      if (cancelled) return;
      const b = (bg ?? {}) as Record<string, unknown>;
      setState({
        custom,
        background: Array.isArray(b.agents) ? (b.agents as BackgroundAgent[]) : [],
        backgroundAvailable: b.available === true,
        backgroundError: typeof b.error === "string" ? b.error : null,
        loaded: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => load(), [load, trigger]);

  return { ...state, refresh: load };
}
