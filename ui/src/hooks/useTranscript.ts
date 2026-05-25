import { useEffect, useState } from "react";

/** One content block in a transcript message (mirrors the gateway shape). */
export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string | null; isError: boolean; text: string };

export interface TranscriptMessage {
  uuid: string | null;
  role: "user" | "assistant" | "tool";
  ts: number | null;
  blocks: TranscriptBlock[];
}

export interface TranscriptState {
  found: boolean;
  messages: TranscriptMessage[];
  loading: boolean;
}

/**
 * Loads a session's full conversation transcript from
 * GET /api/claude/sessions/:id/transcript (US-014), which reads the JSONL under
 * ~/.claude. Only fetches while `active` (the Transcript tab is open) to avoid
 * reading a potentially large file when the tab isn't shown. A missing file
 * resolves to found:false so the viewer can render an empty state.
 */
export function useTranscript(
  sessionId: string | null,
  active: boolean,
): TranscriptState {
  const [state, setState] = useState<TranscriptState>({
    found: false,
    messages: [],
    loading: false,
  });

  useEffect(() => {
    if (!sessionId || !active) {
      setState({ found: false, messages: [], loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/claude/sessions/${encodeURIComponent(sessionId)}/transcript`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setState({
          found: Boolean(data?.found),
          messages: Array.isArray(data?.messages) ? data.messages : [],
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ found: false, messages: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, active]);

  return state;
}
