import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Mirrors RadioState in src/radio/index.ts. */
export interface RadioState {
  videoId: string;
  title: string | null;
}

/**
 * Subscribe to the gateway's Claude Radio state — the videoId + title the
 * bottom-of-HUD player is currently pointed at. Updates on:
 *  - mount (one-shot GET /api/claude/radio)
 *  - any `{type:'radio'}` WS broadcast (fired by POST /api/claude/radio)
 *  - the shared `wsTrigger` seq bumping after a reconnect (so the state
 *    re-syncs across a gateway restart or socket gap)
 *
 * Returns null until the first fetch resolves so RadioBar can keep showing
 * its default "Claude Radio" label and the bundled video ID.
 */
export function useRadio(
  token: string | null,
  wsTrigger: number,
  lastRadio: { payload: RadioState; seq: number } | null,
): RadioState | null {
  const [state, setState] = useState<RadioState | null>(null);

  // Initial fetch + refetch on reconnect.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiBase() + "/api/claude/radio", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.videoId === "string") {
          setState({ videoId: d.videoId, title: d.title ?? null });
        }
      })
      .catch(() => {
        /* gateway unreachable — keep previous state */
      });
    return () => {
      cancelled = true;
    };
  }, [token, wsTrigger]);

  // Live updates from POST /api/claude/radio broadcasts.
  useEffect(() => {
    if (!lastRadio) return;
    const p = lastRadio.payload;
    if (p && typeof p.videoId === "string") {
      setState({ videoId: p.videoId, title: p.title ?? null });
    }
  }, [lastRadio?.seq]);

  return state;
}
