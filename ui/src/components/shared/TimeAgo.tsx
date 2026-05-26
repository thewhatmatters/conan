/**
 * Compact, dependency-free relative time — "3s ago" / "3m ago" / "2h ago" /
 * "5d ago" (v4 US-001, lifted from AgentsView's private copy). Exposed as both a
 * formatter and a thin component so callers can drop it inline.
 */
export function relativeTime(epochMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** A `<time>` showing a relative label with the absolute time as its tooltip. */
export default function TimeAgo({
  at,
  prefix = "",
  className,
}: {
  /** Epoch milliseconds of the moment to describe. */
  at: number;
  /** Optional text rendered before the relative label (e.g. "started "). */
  prefix?: string;
  className?: string;
}) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
      className={className}
    >
      {prefix}
      {relativeTime(at)}
    </time>
  );
}
