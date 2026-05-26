import { SCOPE_HINT, type WidgetScope } from "../hooks/useWidgetPrefs.ts";

/**
 * Two-tier stat card: muted shell + bordered inner panel. The shared visual
 * primitive for the hero metrics row (US-010) and the opt-in secondary widgets
 * (US-022). Semantic tokens only.
 *
 * `scope` (US-019) renders a small badge beside the label marking whether the
 * widget follows the selected session, the active cwd, or is global.
 */
export default function StatCard({
  label,
  sub,
  scope,
  children,
}: {
  label: string;
  sub?: string;
  scope?: WidgetScope;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-muted p-1">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {scope && <ScopeBadge scope={scope} />}
            <span className="truncate text-xs text-muted-foreground">{label}</span>
          </span>
          {sub && (
            <span className="shrink-0 truncate text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {sub}
            </span>
          )}
        </div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

/** Per-widget scope chip (US-019): session / cwd / global, color-coded. */
function ScopeBadge({ scope }: { scope: WidgetScope }) {
  const cls =
    scope === "session"
      ? "bg-primary/10 text-primary"
      : scope === "cwd"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-muted-foreground/15 text-muted-foreground";
  return (
    <span
      title={SCOPE_HINT[scope]}
      className={
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide " +
        cls
      }
    >
      {scope}
    </span>
  );
}
