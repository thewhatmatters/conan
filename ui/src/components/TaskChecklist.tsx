import type { TasksState } from "../hooks/useTasks.ts";

/**
 * The build-loop checklist (Tasks tab). Shows overall progress, every story
 * with a done / in-progress / pending marker, the current target highlighted,
 * and the recent progress.txt activity trail. Updates live over the app WS.
 */
export default function TaskChecklist({ tasks }: { tasks: TasksState | null }) {
  if (!tasks || !tasks.exists) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        No prd.json found — run decompose-prd to create a task list.
      </div>
    );
  }

  const pct = tasks.total ? Math.round((tasks.done / tasks.total) * 100) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">{tasks.branchName || tasks.project}</span>
          <span className="text-muted-foreground">
            {tasks.done}/{tasks.total} done
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {tasks.stories.map((s) => {
          const isCurrent = s.id === tasks.currentId;
          return (
            <li
              key={s.id}
              className={
                "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs " +
                (isCurrent ? "bg-primary/10" : "")
              }
            >
              <Marker passes={s.passes} current={isCurrent} />
              <span className="shrink-0 font-mono text-muted-foreground">
                {s.id}
              </span>
              <span
                className={
                  s.passes
                    ? "text-muted-foreground line-through"
                    : isCurrent
                      ? "font-medium"
                      : ""
                }
              >
                {s.title}
              </span>
            </li>
          );
        })}
      </ol>

      {tasks.activity.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-border px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Activity
          </div>
          <ul className="space-y-0.5 font-mono text-[11px] leading-snug text-muted-foreground">
            {tasks.activity.map((line, i) => (
              <li key={i} className="truncate" title={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Marker({ passes, current }: { passes: boolean; current: boolean }) {
  if (passes)
    return <span className="mt-px text-primary" aria-label="done">✓</span>;
  if (current)
    return (
      <span className="mt-px animate-pulse text-primary" aria-label="in progress">
        ▸
      </span>
    );
  return (
    <span className="mt-px text-muted-foreground/50" aria-label="pending">
      ○
    </span>
  );
}
