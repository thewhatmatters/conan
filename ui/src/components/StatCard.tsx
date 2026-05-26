import { type WidgetScope } from "../hooks/useWidgetPrefs.ts";
import ScopeBadge from "./shared/ScopeBadge.tsx";
import TwoTierCard from "./shared/TwoTierCard.tsx";

/**
 * Two-tier stat card: muted shell + bordered inner panel. The shared visual
 * primitive for the hero metrics row (US-010) and the opt-in secondary widgets
 * (US-022). Now composes the shared TwoTierCard + ScopeBadge primitives
 * (v4 US-001). Semantic tokens only.
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
    <TwoTierCard>
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
    </TwoTierCard>
  );
}
