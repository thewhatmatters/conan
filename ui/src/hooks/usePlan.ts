import { useEffect, useState } from "react";
import { apiBase } from "../lib/gateway.ts";

/** One TodoWrite checklist item — mirrors PlanTodo in src/plan/index.ts. */
export interface PlanTodo {
  content: string;
  status: string; // pending | in_progress | completed
  activeForm: string;
}

/** Where the active plan came from. `none` = no live plan for the session. */
export type PlanSource = "todos" | "plan" | "build-loop" | "none";

/** Reduced plan-state — mirrors PlanState from GET /sessions/:id/plan (US-003). */
export interface PlanState {
  todos: PlanTodo[];
  proposedPlan: string | null;
  source: PlanSource;
  isActive: boolean;
}

const EMPTY: PlanState = {
  todos: [],
  proposedPlan: null,
  source: "none",
  isActive: false,
};

/**
 * Loads the active session's reduced plan-state from the token-gated
 * GET /api/claude/sessions/:id/plan (US-003): latest-wins TodoWrite checklist +
 * last ExitPlanMode plan, with a build-loop fallback. Refetches whenever a new
 * event arrives over the app WS (`eventSeq`) so the checklist tracks live
 * TodoWrite updates, and resets to empty when there's no session/token.
 */
export function usePlan(
  sessionId: string | null,
  eventSeq: number | null,
  token: string | null,
): PlanState {
  const [plan, setPlan] = useState<PlanState>(EMPTY);

  useEffect(() => {
    if (!sessionId || !token) {
      setPlan(EMPTY);
      return;
    }
    let cancelled = false;
    fetch(
      apiBase() + `/api/claude/sessions/${encodeURIComponent(sessionId)}/plan`,
      { headers: { "x-conan-token": token } },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setPlan(d as PlanState);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, eventSeq, token]);

  return plan;
}
