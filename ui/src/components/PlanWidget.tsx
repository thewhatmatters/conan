import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { PlanState, PlanTodo } from "../hooks/usePlan.ts";
import type { TasksState } from "../hooks/useTasks.ts";
import StatCard from "./StatCard.tsx";

/**
 * The Plan HUD tab (US-004): surfaces the active session's plan, reduced from the
 * hook event stream (US-003). Precedence matches the backend reducer:
 *   1. A live TodoWrite checklist (per-item status icon + a done/total count).
 *   2. The last ExitPlanMode proposed-plan markdown when no checklist is live.
 *   3. The build-loop tasks feed as a fallback (source = "build-loop").
 * Themed with semantic tokens only. The conditional tab in Hud.tsx only mounts
 * this when `plan.isActive`, so an inactive/all-completed plan never shows.
 */
export default function PlanWidget({
  plan,
  tasks,
}: {
  plan: PlanState;
  tasks: TasksState | null;
}) {
  // Live TodoWrite checklist — the dominant signal.
  if (plan.todos.length > 0) {
    return <TodoChecklist todos={plan.todos} />;
  }
  // A proposed plan with no checklist yet (just exited plan mode).
  if (plan.source === "plan" && plan.proposedPlan) {
    return (
      <StatCard label="Plan" sub="proposed">
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground">
          {plan.proposedPlan}
        </pre>
      </StatCard>
    );
  }
  // Fallback: the build-loop's prd.json stories.
  if (plan.source === "build-loop" && tasks?.stories.length) {
    return <BuildLoopFeed tasks={tasks} />;
  }
  return (
    <StatCard label="Plan" sub="none">
      <p className="text-[11px] text-muted-foreground">No active plan.</p>
    </StatCard>
  );
}

/** TodoWrite checklist with per-item status icon + a done/total progress count. */
function TodoChecklist({ todos }: { todos: PlanTodo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <StatCard label="Plan" sub={`${done}/${todos.length} done`}>
      <ul className="flex flex-col gap-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
            <TodoIcon status={t.status} />
            <span
              className={
                t.status === "completed"
                  ? "text-muted-foreground line-through"
                  : t.status === "in_progress"
                    ? "font-medium text-foreground"
                    : "text-foreground"
              }
            >
              {t.status === "in_progress" && t.activeForm
                ? t.activeForm
                : t.content}
            </span>
          </li>
        ))}
      </ul>
    </StatCard>
  );
}

function TodoIcon({ status }: { status: string }) {
  if (status === "completed")
    return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />;
  if (status === "in_progress")
    return (
      <CircleDot className="mt-0.5 size-3.5 shrink-0 animate-pulse text-amber-500" />
    );
  return (
    <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
  );
}

/** Build-loop fallback: the prd.json stories with pass/active state. */
function BuildLoopFeed({ tasks }: { tasks: TasksState }) {
  return (
    <StatCard label="Plan" sub={`build loop · ${tasks.done}/${tasks.total}`}>
      <ul className="flex flex-col gap-1.5">
        {tasks.stories.map((s) => {
          const active = s.id === tasks.currentId;
          return (
            <li
              key={s.id}
              className="flex items-start gap-2 text-[12px] leading-snug"
            >
              {s.passes ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
              ) : active ? (
                <CircleDot className="mt-0.5 size-3.5 shrink-0 animate-pulse text-amber-500" />
              ) : (
                <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
              )}
              <span
                className={
                  s.passes
                    ? "text-muted-foreground line-through"
                    : active
                      ? "font-medium text-foreground"
                      : "text-foreground"
                }
              >
                {s.title}
              </span>
            </li>
          );
        })}
      </ul>
    </StatCard>
  );
}
