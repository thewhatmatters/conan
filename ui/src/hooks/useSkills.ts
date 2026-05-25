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
