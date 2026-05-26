import { useEffect, useState } from "react";
import type { TranscriptMessage } from "./useTranscript.ts";

/**
 * One reconstructed subagent node (US-014 / US-035), mirroring the gateway's
 * SubagentNode shape from GET /api/claude/sessions/:id/subagents. Each node
 * carries its own normalized transcript and any subagents it itself spawned.
 */
export interface SubagentNode {
  agentId: string;
  agentType: string | null;
  description: string | null;
  /** The parent Task tool_use id that spawned this subagent; null when absent. */
  toolUseId: string | null;
  transcript: TranscriptMessage[];
  children: SubagentNode[];
}

export interface SubagentsState {
  /** Whether a subagents directory was found on disk for this session. */
  found: boolean;
  /** Root subagents (each with nested children); empty when none on disk. */
  subagents: SubagentNode[];
  loading: boolean;
}

const EMPTY: SubagentsState = { found: false, subagents: [], loading: false };

/**
 * Loads a session's subagent tree reconstructed from disk (US-035), from
 * GET /api/claude/sessions/:id/subagents (US-014). Works for any session —
 * past, observed, or one Conan never launched — not just live ones tracked via
 * parent_tool_use_id. Only fetches while `active` so the (potentially large)
 * agent-*.jsonl files aren't read when the timeline isn't shown. A missing
 * directory resolves to { found:false, subagents:[] } so the consumer can fall
 * back to the live tree.
 */
export function useSubagents(
  sessionId: string | null,
  active: boolean,
): SubagentsState {
  const [state, setState] = useState<SubagentsState>(EMPTY);

  useEffect(() => {
    if (!sessionId || !active) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/claude/sessions/${encodeURIComponent(sessionId)}/subagents`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setState({
          found: Boolean(data?.found),
          subagents: Array.isArray(data?.subagents) ? data.subagents : [],
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, active]);

  return state;
}
