import { useHooksCoverage } from "../hooks/useHooksCoverage.ts";
import { Badge } from "./ui/badge.tsx";

/**
 * Hooks-coverage panel (US-033). Renders the US-009 coverage data: the full
 * known Claude Code hook-event set, each marked consumed-by-Conan and
 * wired-or-not per settings scope (user + project). Events Conan can't consume
 * yet, and events that are unwired in both scopes, are flagged so the coverage
 * gap is visible at a glance. Read-only; refetches on each WS event.
 */
export default function HooksCoveragePanel({
  trigger,
}: {
  trigger: number | null;
}) {
  const { data, loaded } = useHooksCoverage(trigger);

  if (!loaded) {
    return <span className="text-sm text-muted-foreground">Loading…</span>;
  }
  if (!data || data.events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
        No hook-coverage data available.
      </div>
    );
  }

  const { events, summary } = data;

  return (
    <div>
      {/* Summary line */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{summary.consumed}</span>{" "}
          of {summary.total} events consumed by Conan
        </span>
        {summary.unconsumed > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {summary.unconsumed} not yet consumed
          </span>
        )}
        <span>
          wired — user{" "}
          <span className="font-medium text-foreground">{summary.wiredUser}</span>
          {" · "}project{" "}
          <span className="font-medium text-foreground">
            {summary.wiredProject}
          </span>
        </span>
      </div>

      {/* Header row */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-b border-border pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Event</span>
        <span className="text-center">Conan</span>
        <span className="text-center">User</span>
        <span className="text-center">Project</span>
      </div>

      <ul className="divide-y divide-border">
        {events.map((e) => {
          const unwired = !e.wired.user && !e.wired.project;
          return (
            <li
              key={e.event}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-foreground">
                    {e.event}
                  </span>
                  {!e.consumedByConan && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/50 text-amber-600 dark:text-amber-400"
                    >
                      no ingestion path
                    </Badge>
                  )}
                  {unwired && (
                    <Badge variant="secondary">unwired</Badge>
                  )}
                </div>
                {e.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {e.description}
                  </p>
                )}
              </div>
              <CoverageDot on={e.consumedByConan} title="Consumed by Conan" />
              <CoverageDot on={e.wired.user} title="Wired in user settings" />
              <CoverageDot on={e.wired.project} title="Wired in project settings" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A small on/off status dot, centered in its column. */
function CoverageDot({ on, title }: { on: boolean; title: string }) {
  return (
    <span className="flex justify-center" title={title}>
      <span
        className={
          "size-2.5 rounded-full " +
          (on ? "bg-primary" : "border border-border bg-transparent")
        }
        aria-label={on ? `${title}: yes` : `${title}: no`}
      />
    </span>
  );
}
