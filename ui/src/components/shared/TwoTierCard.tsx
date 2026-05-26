import { cn } from "../../lib/utils.ts";

/**
 * The "two-tier card" shell (v4 US-001): a muted outer shell wrapping a
 * bordered `bg-card` inner panel. The shared primitive behind StatCard and the
 * PendingApprovals panel. Pass `innerClassName` to tune the inner padding
 * (tailwind-merge lets callers override the default p-3, e.g. with p-0).
 * Semantic tokens only.
 */
export default function TwoTierCard({
  as: Tag = "div",
  className,
  innerClassName,
  children,
}: {
  /** Outer element tag (e.g. "section"). Defaults to "div". */
  as?: "div" | "section" | "li";
  /** Extra classes on the muted shell. */
  className?: string;
  /** Extra classes on the inner panel (overrides the default padding). */
  innerClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag className={cn("rounded-xl bg-muted p-1", className)}>
      <div className={cn("rounded-lg border border-border bg-card p-3", innerClassName)}>
        {children}
      </div>
    </Tag>
  );
}
