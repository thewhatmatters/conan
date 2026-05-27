import { useCallback, useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

export interface Session {
  id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  permission_mode: string | null;
  status: string;
  color: string | null;
  created_at: number;
  last_activity: number;
  total_cost_usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  context_tokens: number | null;
  /** Worktree this session runs in (US-043); null for normal launches. */
  worktree_path: string | null;
  /** Base ref the worktree branch was cut from (US-043). */
  worktree_base_ref: string | null;
}

/**
 * Loads the session grid from GET /api/claude/sessions (US-009) and refetches
 * whenever a new Claude Code event arrives over the app WS, so the grid stays
 * live without its own socket. `eventSeq` is the monotonically-increasing seq
 * from useGateway's lastEvent.
 */
export function useSessions(eventSeq: number | null): {
  sessions: Session[];
  refresh: () => void;
} {
  const [sessions, setSessions] = useState<Session[]>([]);

  const refresh = useCallback(() => {
    fetch(apiBase() + "/api/claude/sessions")
      .then((r) => r.json())
      .then((rows) => setSessions(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, eventSeq]);

  return { sessions, refresh };
}
