import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** A live terminal + the Claude session running inside it (mirrors the gateway). */
export interface TerminalInfo {
  tid: string;
  /** The /renamed session name, or null when unnamed / no live session. */
  name: string | null;
  /** The correlated Claude session id, or null when none is live. */
  sessionId: string | null;
  /** First 8 chars of `sessionId`, for the compact dropdown label. */
  shortId: string | null;
  /**
   * The pty's current working directory (1.0.1 US-001/US-003): the gateway's
   * per-tab lastKnownCwd falling back to the spawn cwd, or null when missing.
   */
  cwd: string | null;
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
      fetch(apiBase() + "/api/terminals")
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
              cwd: typeof t.cwd === "string" && t.cwd ? t.cwd : null,
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

/** The last path segment of a cwd ("/Users/x/Development/conan" → "conan"). */
function cwdBasename(cwd: string | null): string | null {
  if (!cwd) return null;
  const base = cwd.replace(/\/+$/, "").split("/").pop();
  return base || null; // "/" reduces to "" — treat as no basename
}

/**
 * The label for one terminal (1.0.1 US-003 fallback chain): the session
 * "name:shortId" when the pty's Claude session has been /renamed (always wins),
 * else the cwd folder basename, else the positional "Term N" fallback.
 * Duplicate basenames across the strip are handled by `terminalLabels()`.
 */
export function terminalLabel(
  info: TerminalInfo | undefined,
  index: number,
): string {
  if (info?.name && info.shortId) return `${info.name}:${info.shortId}`;
  return cwdBasename(info?.cwd ?? null) ?? `Term ${index + 1}`;
}

/**
 * Labels for the whole tab strip, keyed by tid. Same chain as `terminalLabel`,
 * plus disambiguation: when two un-renamed tabs share a cwd basename, later
 * ones get a positional suffix ("conan", "conan 2") so the strip never shows
 * two identical labels. Renamed labels carry the session shortId and "Term N"
 * carries the index, so only cwd-derived labels need it.
 */
export function terminalLabels(
  terms: ReadonlyArray<{ tid: string }>,
  byTid: Map<string, TerminalInfo>,
): Map<string, string> {
  const labels = new Map<string, string>();
  const seen = new Map<string, number>(); // cwd basename → occurrences so far
  terms.forEach((t, i) => {
    const info = byTid.get(t.tid);
    let label = terminalLabel(info, i);
    const fromCwd =
      !(info?.name && info.shortId) && cwdBasename(info?.cwd ?? null) === label;
    if (fromCwd) {
      const n = (seen.get(label) ?? 0) + 1;
      seen.set(label, n);
      if (n > 1) label = `${label} ${n}`;
    }
    labels.set(t.tid, label);
  });
  return labels;
}
