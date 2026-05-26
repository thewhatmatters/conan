import { cn } from "../../lib/utils.ts";

/**
 * A small status dot (v4 US-001 — lifted from the bespoke copies in SessionBar,
 * AgentsView, etc.). Drives its color from a session-style `status` string and
 * shows a "ping" halo for running/active sessions, matching the richest existing
 * variant (SessionBar). Callers may override the color with `tone` to preserve a
 * one-off shade. Semantic tokens only.
 */
export default function StatusDot({
  status,
  ping,
  tone,
  className,
}: {
  /** Session-style status; drives default color and the default ping. */
  status?: string;
  /** Force the ping halo on/off (defaults to on when status is "running"). */
  ping?: boolean;
  /** Override the dot color class entirely (e.g. "bg-muted-foreground/50"). */
  tone?: string;
  /** Extra classes on the outer wrapper. */
  className?: string;
}) {
  const showPing = ping ?? status === "running";
  const color = tone ?? defaultTone(status);
  return (
    <span
      className={cn(
        "relative inline-flex size-2.5 shrink-0 items-center justify-center",
        className,
      )}
    >
      {showPing && (
        <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-primary/60" />
      )}
      <span className={cn("size-2 rounded-full", color)} />
    </span>
  );
}

/** Default color for a session-style status string. */
function defaultTone(status?: string): string {
  switch (status) {
    case "running":
      return "bg-primary";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}
