import { useEffect, useState } from "react";

/** One file snapshot (mirrors the gateway's CheckpointSnapshot, US-008). */
export interface CheckpointSnapshot {
  sessionId: string;
  /** Content-addressed file identity; revisions of one file share a hash. */
  hash: string;
  /** The @vN suffix as a number, or null if unparseable. */
  version: number | null;
  /** Snapshot file mtime in epoch ms. */
  mtime: number;
}

/** All snapshots for one session (mirrors CheckpointSession). */
export interface CheckpointSession {
  sessionId: string;
  snapshots: CheckpointSnapshot[];
  latestMtime: number;
}

export interface CheckpointsState {
  sessions: CheckpointSession[];
  /** True until the first fetch settles. */
  loaded: boolean;
}

/** A single snapshot's content (mirrors the gateway's SnapshotContent). */
export interface SnapshotContent {
  sessionId: string;
  hash: string;
  version: number | null;
  mtime: number;
  content: string;
}

/**
 * Loads the per-session file-history checkpoints (US-031) from
 * GET /api/claude/checkpoints (US-008): every session that has snapshots under
 * ~/.claude/file-history, grouped per session and sorted most-recently-active
 * first. Refetches on each new WS event so newly-written snapshots surface.
 * Read-only — there is no restore.
 */
export function useCheckpoints(eventSeq: number | null): CheckpointsState {
  const [state, setState] = useState<CheckpointsState>({
    sessions: [],
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/claude/checkpoints")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setState({
          sessions: Array.isArray(d?.sessions)
            ? (d.sessions as CheckpointSession[])
            : [],
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ sessions: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [eventSeq]);

  return state;
}

/**
 * Fetch a single snapshot's content for preview (read-only) from
 * GET /api/claude/checkpoints/:sessionId/content?hash=&version=. Returns null
 * on 404 / network error so the caller can render a not-found state.
 */
export async function fetchSnapshotContent(
  sessionId: string,
  hash: string,
  version: number | null,
): Promise<SnapshotContent | null> {
  const qs = new URLSearchParams({ hash });
  if (version != null) qs.set("version", String(version));
  try {
    const r = await fetch(
      `/api/claude/checkpoints/${encodeURIComponent(sessionId)}/content?${qs.toString()}`,
    );
    if (!r.ok) return null;
    return (await r.json()) as SnapshotContent;
  } catch {
    return null;
  }
}
