import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

export type PulseCategory =
  | "tool"
  | "assistant"
  | "prompt"
  | "session"
  | "other";

export interface PulseBucket {
  t: number;
  events: number;
  /** Per-category breakdown of `events` (stacked by the chart); sums to events. */
  types: Record<PulseCategory, number>;
  retries: number;
  tokens: number;
  cost: number;
}

export interface PulseSeries {
  windowMs: number;
  bucketMs: number;
  now: number;
  buckets: PulseBucket[];
  totals: { events: number; retries: number; tokens: number; cost: number };
}

/**
 * Loads the Pulse time-series from GET /api/claude/pulse (US-020). Refetches
 * whenever a new event arrives over the app WS (`eventSeq`) or the window
 * changes, and on a slow interval so the trailing edge of the time axis keeps
 * advancing even during a lull.
 */
export function usePulse(
  eventSeq: number | null,
  minutes: number,
): PulseSeries | null {
  const [series, setSeries] = useState<PulseSeries | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch(apiBase() + `/api/claude/pulse?minutes=${minutes}`)
        .then((r) => r.json())
        .then((s) => {
          if (alive && s && Array.isArray(s.buckets)) setSeries(s);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [eventSeq, minutes]);

  return series;
}
