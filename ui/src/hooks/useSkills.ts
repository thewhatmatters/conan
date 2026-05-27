import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** Where a skill came from — mirrors SkillSource in src/skills/index.ts. */
export type SkillSource = "User" | "Project" | "Plugin" | "Built-in";

/** One installed skill — mirrors SkillEntry from GET /api/claude/skills (US-005). */
export interface SkillEntry {
  name: string;
  /** Frontmatter description, or null when none is readable (never fabricated). */
  description: string | null;
  source: SkillSource;
  /** Plugin key when source === "Plugin". */
  plugin?: string;
}

/**
 * Loads the installed skills (name + description + source) from the token-gated
 * GET /api/claude/skills (US-005). Skills are static for a session — fetched
 * once when the token first arrives and cached for the panel's lifetime (no
 * per-event refetch like usePlan, since SKILL.md frontmatter doesn't change at
 * runtime). Resets to empty when there's no token.
 */
export function useSkills(token: string | null): SkillEntry[] {
  const [skills, setSkills] = useState<SkillEntry[]>([]);

  useEffect(() => {
    if (!token) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    fetch(apiBase() + "/api/claude/skills", {
      headers: { "x-conan-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && Array.isArray(d)) setSkills(d as SkillEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  return skills;
}
