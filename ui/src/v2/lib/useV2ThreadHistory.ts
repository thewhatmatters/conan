/**
 * v2 reopened-thread history adapter (p2d US-501).
 *
 * Selecting a saved thread has to OPEN THAT CONVERSATION, not just point the
 * well at a cwd. Two things make that true, and both hang off this hook:
 *
 *   1. the past turns render above the live ones — reconstructed by the
 *      gateway from Claude's own JSONL via
 *      `GET /api/agent/threads/:sessionId/transcript`;
 *   2. the next prompt launches with `--resume <sessionId>` so the agent still
 *      has the context — but ONLY when the history was actually found.
 *
 * That gate is v1's (`ChatPane` `historyState === "found"`) and it is the
 * whole reason this is a hook and not two inline fetches: a thread whose JSONL
 * is gone (or a codex/grok thread, where reconstruction is Claude-only)
 * degrades to a FRESH session, which still works, instead of resuming a
 * session id the driver will reject.
 *
 * Adds no route; the gateway and v1 are untouched.
 */
import { useEffect, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";
import type { ChatItem } from "./useV2Chat.ts";

/** One reconstructed entry — mirrors the gateway's `HistoryItem`. */
type HistoryItem =
  | { role: "user" | "assistant" | "reasoning"; text: string; ts?: number | null }
  | {
      role: "tool";
      id: string;
      name: string;
      input: unknown;
      result: string | null;
      isError: boolean;
      ts?: number | null;
    };

/** `null` = nothing to reopen (a draft). */
export type V2HistoryState = "loading" | "found" | "missing" | null;

export interface V2ThreadHistory {
  /** Restored transcript items, prepended above the live ones. */
  items: ChatItem[];
  state: V2HistoryState;
  /** The session id safe to pass as `--resume`, else null. */
  resumeSessionId: string | null;
}

const NONE: ChatItem[] = [];

export function useV2ThreadHistory(
  token: string | null,
  sessionId: string | null | undefined,
): V2ThreadHistory {
  const [items, setItems] = useState<ChatItem[]>(NONE);
  const [state, setState] = useState<V2HistoryState>(sessionId ? "loading" : null);

  useEffect(() => {
    if (!sessionId || !token) {
      setItems(NONE);
      setState(null);
      return;
    }
    let cancelled = false;
    setItems(NONE);
    setState("loading");
    void (async () => {
      try {
        const r = await fetch(
          apiBase() +
            `/api/agent/threads/${encodeURIComponent(sessionId)}/transcript`,
          { headers: { "x-conan-token": token } },
        );
        const data = (await r.json()) as {
          found?: boolean;
          items?: HistoryItem[];
        };
        if (cancelled) return;
        if (!r.ok || !data.found) {
          setState("missing");
          return;
        }
        // `h`-prefixed ids keep restored rows from colliding with live ones —
        // a resumed tool call can carry the same tool_use id twice.
        setItems(
          (data.items ?? []).map((it, i) =>
            it.role === "tool"
              ? ({ ...it, id: `h${i}-${it.id}` } as ChatItem)
              : ({ id: `h${i}`, role: it.role, text: it.text, ts: it.ts } as ChatItem),
          ),
        );
        setState("found");
      } catch {
        if (!cancelled) setState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, token]);

  return {
    items,
    state,
    resumeSessionId: state === "found" && sessionId ? sessionId : null,
  };
}
