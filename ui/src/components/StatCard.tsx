/**
 * Two-tier stat card: muted shell + bordered inner panel. The shared visual
 * primitive for the hero metrics row (US-010) and the opt-in secondary widgets
 * (US-022). Semantic tokens only.
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
    <div className="rounded-xl bg-muted p-1">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {sub && (
            <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground/70">
              {sub}
            </span>
          )}
        </div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}
