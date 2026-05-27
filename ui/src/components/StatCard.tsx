import TwoTierCard from "./shared/TwoTierCard.tsx";

/**
 * Two-tier stat card: muted shell + bordered inner panel. The shared visual
 * primitive for the HUD widget cells (Context + Usage, US-004). Composes the
 * shared TwoTierCard primitive. Semantic tokens only.
 */
export default function StatCard({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <TwoTierCard>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
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
