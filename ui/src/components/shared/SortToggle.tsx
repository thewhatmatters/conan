/** Sort direction by timestamp — newest-first ("desc") or oldest-first ("asc"). */
export type SortDir = "asc" | "desc";

/**
 * Newest/oldest-first sort toggle (originally US-021, extracted to a shared
 * component in v4 US-001 so the timeline and the transcript view consume one
 * implementation). A single button that flips the order and labels the current
 * choice; the arrow glyph rotates to match. Semantic tokens only.
 */
export default function SortToggle({
  value,
  onChange,
  className = "",
}: {
  value: SortDir;
  onChange: (v: SortDir) => void;
  /** Extra classes appended to the button (e.g. layout tweaks). */
  className?: string;
}) {
  const newest = value === "desc";
  return (
    <button
      onClick={() => onChange(newest ? "asc" : "desc")}
      aria-label={`Sort by time, ${newest ? "newest" : "oldest"} first`}
      title={`Sorted ${newest ? "newest" : "oldest"} first — click to flip`}
      className={
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted " +
        className
      }
    >
      <span className={newest ? "" : "rotate-180"}>
        <svg
          width={13}
          height={13}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </svg>
      </span>
      {newest ? "Newest first" : "Oldest first"}
    </button>
  );
}
