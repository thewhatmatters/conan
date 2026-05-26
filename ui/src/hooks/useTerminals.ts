import { useEffect, useState } from "react";

/** A live terminal + the Claude session running inside it (mirrors the gateway). */
export interface TerminalInfo {
  tid: string;
  /** The /renamed session name, or null when unnamed / no live session. */
  name: string | null;
  /** The correlated Claude session id, or null when none is live. */
  sessionId: string | null;
  /** First 8 chars of `sessionId`, for the compact dropdown label. */
  shortId: string | null;
}

/** Poll interval (ms) so a mid-session /rename surfaces in the label live (US-036). */
const POLL_MS = 4000;

/**
 * Polls GET /api/terminals so the Term ▾ dropdown can label each tab by the
 * Claude session running inside it (name + short id). Returns a map keyed by
 * the terminal's `tid`; a tab with no live session simply has no entry and the
 * dropdown falls back to "Term N". Polling (not WS) keeps it simple — a
 * /rename inside the pty has no app-WS event to hang off of.
 */
export function useTerminals(): Map<string, TerminalInfo> {
  const [byTid, setByTid] = useState<Map<string, TerminalInfo>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      fetch("/api/terminals")
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          const next = new Map<string, TerminalInfo>();
          const list = Array.isArray(data?.terminals) ? data.terminals : [];
          for (const t of list) {
            if (typeof t?.tid !== "string") continue;
            next.set(t.tid, {
              tid: t.tid,
              name: typeof t.name === "string" && t.name ? t.name : null,
              sessionId: typeof t.sessionId === "string" ? t.sessionId : null,
              shortId: typeof t.shortId === "string" ? t.shortId : null,
            });
          }
          setByTid(next);
        })
        .catch(() => {});
    };
    pull();
    const timer = setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return byTid;
}

/**
 * The dropdown label for one terminal: the session "name:shortId" when the
 * pty's Claude session has been /renamed, else the positional "Term N" fallback.
 */
export function terminalLabel(
  info: TerminalInfo | undefined,
  index: number,
): string {
  if (info?.name && info.shortId) return `${info.name}:${info.shortId}`;
  return `Term ${index + 1}`;
}
