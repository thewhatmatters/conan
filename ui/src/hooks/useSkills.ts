import { useEffect, useState } from "react";

export interface SkillsState {
  available: number;
  loaded: number | null;
}

/**
 * Loads the Skills hero widget data from GET /api/claude/skills (US-010):
 * total skills available on the machine + how many the active session loaded.
 * Refetches whenever the active session changes or a new WS event arrives
 * (via `eventSeq`) so the "loaded" figure stays live.
 */
export function useSkills(
  activeSessionId: string | null,
  eventSeq: number | null,
): SkillsState {
  const [skills, setSkills] = useState<SkillsState>({
    available: 0,
    loaded: null,
  });

  useEffect(() => {
    const qs = activeSessionId
      ? `?session_id=${encodeURIComponent(activeSessionId)}`
      : "";
    fetch(`/api/claude/skills${qs}`)
      .then((r) => r.json())
      .then((s) =>
        setSkills({
          available: typeof s.available === "number" ? s.available : 0,
          loaded: typeof s.loaded === "number" ? s.loaded : null,
        }),
      )
      .catch(() => {});
  }, [activeSessionId, eventSeq]);

  return skills;
}

/** One skill in the browsable catalog (mirrors the gateway's SkillInfo). */
export interface SkillInfo {
  name: string;
  description: string | null;
  scope: "user" | "project";
  loaded: boolean | null;
  source: string;
}

export interface SkillsListState {
  skills: SkillInfo[];
  /** True until the first fetch settles. */
  loaded: boolean;
}

/**
 * Loads the browsable skills catalog (US-028) from GET /api/claude/skills/list
 * (US-016): every skill across the user (~/.claude/skills) and active-project
 * (<cwd>/.claude/skills) scopes, with name/description/scope and a per-session
 * `loaded` flag. Refetches when the active session changes, when the active cwd
 * changes (so project skills follow the toolbar cwd), or on a new WS event.
 */
export function useSkillsList(
  activeSessionId: string | null,
  cwd: string | null,
  eventSeq: number | null,
): SkillsListState {
  const [state, setState] = useState<SkillsListState>({
    skills: [],
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    const qs = activeSessionId
      ? `?session_id=${encodeURIComponent(activeSessionId)}`
      : "";
    fetch(`/api/claude/skills/list${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setState({
          skills: Array.isArray(d?.skills) ? (d.skills as SkillInfo[]) : [],
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ skills: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, cwd, eventSeq]);

  return state;
}
