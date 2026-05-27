/**
 * Flush, panel-native widget section (US-014). The shared visual primitive for
 * the HUD widget cells (Context, Usage, Plan). Originally a two-tier "card"
 * (muted shell + bordered inner panel); flattened so the HUD tabs read as one
 * continuous surface à la Linear — no rounded corners, no box-border, no inset
 * background panel. It owns its own padding (the tab body no longer pads), and a
 * full-width `border-b` divider (edge-to-edge, suppressed on the last section)
 * separates stacked sections like the PulseChart compact rule. Semantic tokens
 * only.
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
    <section className="border-b border-border px-3 py-3 last:border-b-0">
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
    </section>
  );
}
