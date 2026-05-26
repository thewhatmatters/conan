import { SCOPE_HINT, type WidgetScope } from "../../hooks/useWidgetPrefs.ts";

/**
 * Per-widget scope chip (US-019, extracted to a shared component in v4 US-001):
 * session / cwd / global, color-coded, with the rationale as its tooltip.
 * Semantic tokens only.
 */
export default function ScopeBadge({ scope }: { scope: WidgetScope }) {
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
