import { listEvents, type EventRow } from "../session/index.js";

// Per-session plan-state (US-003), reduced from the hook event stream already on
// the wire — no new capture. Claude Code's TodoWrite and ExitPlanMode tool calls
// arrive as PreToolUse/PostToolUse hook events carrying the full `tool_input`
// (TodoWrite -> {todos:[{content,status,activeForm}]}, ExitPlanMode -> {plan}).
// The Plan HUD tab (US-004) consumes the reduced state; this route rehydrates it
// from the persisted `event` table so a reconnecting client restores the plan.

/** One TodoWrite checklist item, as Claude Code emits it. */
export interface PlanTodo {
  content: string;
  status: string; // pending | in_progress | completed
  activeForm: string;
}

/** Where the active plan came from. `none` = no live plan for the session. */
export type PlanSource = "todos" | "plan" | "build-loop" | "none";

/** Reduced plan-state for a session — the shape the UI's usePlan hook expects. */
export interface PlanState {
  /** Latest-wins TodoWrite checklist (empty when none seen). */
  todos: PlanTodo[];
  /** Last ExitPlanMode plan markdown (null when none seen). */
  proposedPlan: string | null;
  /** The dominant source under the precedence below. */
  source: PlanSource;
  /** True when there's a plan worth showing in the HUD. */
  isActive: boolean;
}

/**
 * How long after the last ExitPlanMode an un-superseded plan still counts as the
 * session's active plan. Past this it's stale (the session likely moved on
 * without a TodoWrite list), so we stop surfacing it.
 */
const PLAN_MAX_AGE_MS = 30 * 60_000;

interface ReduceOpts {
  /** Whether a build loop is in progress (fallback source). */
  buildLoopActive?: boolean;
  /** Clock injection for testability. */
  now?: number;
  /** Override the plan staleness window (testability). */
  planMaxAgeMs?: number;
}

function parsePayload(row: EventRow): Record<string, unknown> | null {
  if (!row.payload) return null;
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toolInput(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const ti = payload?.tool_input;
  return ti && typeof ti === "object" ? (ti as Record<string, unknown>) : null;
}

function asTodos(value: unknown): PlanTodo[] {
  if (!Array.isArray(value)) return [];
  const out: PlanTodo[] = [];
  for (const t of value) {
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      if (typeof o.content === "string" && typeof o.status === "string") {
        out.push({
          content: o.content,
          status: o.status,
          activeForm: typeof o.activeForm === "string" ? o.activeForm : "",
        });
      }
    }
  }
  return out;
}

/**
 * Reduce a session's persisted events into plan-state. Pure (no DB / clock of
 * its own) so the precedence is unit-testable. Events may be in any order; we
 * keep the latest-by-timestamp TodoWrite todos and ExitPlanMode plan.
 *
 * Precedence (US-003 notes — live TodoWrite -> ExitPlanMode seed -> build-loop):
 *  - A TodoWrite list, once seen, is the dominant signal: isActive iff at least
 *    one item is not completed. An all-completed list means the work finished,
 *    so the tab hides (US-004) — even if an older ExitPlanMode plan lingers.
 *  - With no TodoWrite list, a *recent* ExitPlanMode plan is the active plan.
 *  - With neither, an active build loop is the fallback source.
 */
export function reducePlanState(events: EventRow[], opts: ReduceOpts = {}): PlanState {
  const now = opts.now ?? Date.now();
  const planMaxAgeMs = opts.planMaxAgeMs ?? PLAN_MAX_AGE_MS;

  let todos: PlanTodo[] = [];
  let todosTs = -1;
  let proposedPlan: string | null = null;
  let planTs = -1;

  for (const row of events) {
    if (row.tool_name === "TodoWrite") {
      const ti = toolInput(parsePayload(row));
      const parsed = asTodos(ti?.todos);
      // Latest-wins; a TodoWrite always carries the full list (may be empty).
      if (ti && "todos" in ti && row.ts >= todosTs) {
        todos = parsed;
        todosTs = row.ts;
      }
    } else if (row.tool_name === "ExitPlanMode") {
      const ti = toolInput(parsePayload(row));
      const plan = ti?.plan;
      if (typeof plan === "string" && plan.length > 0 && row.ts >= planTs) {
        proposedPlan = plan;
        planTs = row.ts;
      }
    }
  }

  // Precedence — TodoWrite list (if any was ever seen) dominates the plan.
  if (todosTs >= 0) {
    const hasOpen = todos.some((t) => t.status !== "completed");
    return { todos, proposedPlan, source: "todos", isActive: hasOpen };
  }
  if (proposedPlan && now - planTs <= planMaxAgeMs) {
    return { todos, proposedPlan, source: "plan", isActive: true };
  }
  if (opts.buildLoopActive) {
    return { todos, proposedPlan, source: "build-loop", isActive: true };
  }
  return { todos, proposedPlan, source: "none", isActive: false };
}

/**
 * Rehydrate a session's plan-state from the persisted event table (US-003) so a
 * reconnecting client restores the current plan. `buildLoopActive` is the
 * fallback signal supplied by the route from the tasks reader.
 */
export function readPlanState(sessionId: string, buildLoopActive: boolean): PlanState {
  return reducePlanState(listEvents(sessionId), { buildLoopActive });
}
