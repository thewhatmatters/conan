/**
 * v2 projects + threads adapter (p2d US-501).
 *
 * The sidebar's source of truth: `GET /api/agent/projects` returns every
 * persisted project with its `chat_thread` rows, newest activity first. This
 * is an ADAPTER over that route in v1's exact fetch shape (see
 * `ChatSurface.tsx` `refresh()`), not a copy of ChatSurface — v2 owns no
 * session/draft bookkeeping here, only the read model the shell renders.
 *
 * The gateway and v1 are untouched; this hook adds no route.
 *
 * `loaded` is deliberately separate from `projects.length` — "the fetch has
 * not happened yet" and "you genuinely have no projects" render differently
 * (a quiet tree vs. an empty state), and collapsing them would flash an
 * "add your first project" prompt at every boot.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";

/** A project row — a chosen folder every thread inside it uses as its cwd. */
export interface V2Project {
  id: string;
  /** Absolute path of the project folder. */
  path: string;
  /** Display name: the folder basename. */
  name: string;
  createdAt: number;
  /** Git repo root containing the folder, gateway-computed. Null = not a repo. */
  repoRoot?: string | null;
}

/** A persisted `chat_thread` row. Mirrors v1's `SavedThread`. */
export interface V2SavedThread {
  sessionId: string;
  cwd: string;
  model: string | null;
  /** 'claude' | 'codex' | 'grok'; the gateway coalesces pre-migration nulls. */
  provider: string | null;
  effort: string | null;
  title: string | null;
  /** Last assistant response / prompt preview — the row's subtitle. */
  lastMessage: string | null;
  createdAt: number;
  lastActivity: number;
}

export interface V2ProjectWithThreads extends V2Project {
  threads: V2SavedThread[];
}

export interface V2Projects {
  projects: V2ProjectWithThreads[];
  /** A fetch has completed at least once (success or failure). */
  loaded: boolean;
  /** The last fetch failed — the tree says so instead of lying "no projects". */
  error: boolean;
  /** Re-pull the list; returns the rows so callers can act on fresh data. */
  refresh: () => Promise<V2ProjectWithThreads[] | null>;
}

const EMPTY: V2ProjectWithThreads[] = [];

export function useV2Projects(token: string | null): V2Projects {
  const [projects, setProjects] = useState<V2ProjectWithThreads[]>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  // Guards a setState after unmount when a refresh is in flight.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<
    V2ProjectWithThreads[] | null
  > => {
    if (!token) return null;
    try {
      const r = await fetch(apiBase() + "/api/agent/projects", {
        headers: { "x-conan-token": token },
      });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { projects?: V2ProjectWithThreads[] };
      const rows = (data.projects ?? []).map((p) => ({
        ...p,
        threads: p.threads ?? [],
      }));
      if (!alive.current) return rows;
      setProjects(rows);
      setError(false);
      setLoaded(true);
      return rows;
    } catch {
      if (alive.current) {
        setError(true);
        setLoaded(true);
      }
      return null;
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void refresh();
  }, [token, refresh]);

  return { projects, loaded, error, refresh };
}
