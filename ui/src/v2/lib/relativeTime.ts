/**
 * Relative timestamps for the sidebar's thread rows (WHA-87 / WHA-75).
 *
 * The artboard's row ends in a relative time like `2d ago`. That exact shape is
 * `Intl.RelativeTimeFormat`'s `narrow` style with `numeric: "always"` — no
 * dependency, and it localizes for free:
 *
 *   narrow  → "2d ago"   "1h ago"   "5m ago"   "3mo ago"   "1y ago"
 *   short   → "2 days ago"  …       long → "2 days ago"  …
 *
 * `numeric: "auto"` is deliberately NOT used: it turns -1 day into "yesterday",
 * which is longer than the slot was designed for and reads inconsistently next
 * to "2d ago" one row down.
 *
 * A relative label is a lossy summary, so `formatAbsoluteTime` gives the row the
 * full datetime to hang off `title`/`dateTime` — that is what keeps "2d ago"
 * honest when someone needs the real answer.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, {
  numeric: "always",
  style: "narrow",
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Past 30 days we switch to months; past 365, to years. Weeks are skipped —
 *  "2w ago" and "14d ago" describe the same gap and mixing them reads noisy. */
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * `2d ago` for a thread's last activity.
 *
 * Anything under a minute — including a future timestamp, which happens when the
 * gateway's clock runs ahead of the renderer's — collapses to "now" rather than
 * rendering "in 3s". A row that claims activity in the future reads as a bug.
 */
export function formatRelativeTime(
  timestampMs: number,
  nowMs: number = Date.now(),
): string {
  if (!Number.isFinite(timestampMs)) return "";
  const elapsed = nowMs - timestampMs;
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return RELATIVE.format(-Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return RELATIVE.format(-Math.floor(elapsed / HOUR), "hour");
  if (elapsed < MONTH) return RELATIVE.format(-Math.floor(elapsed / DAY), "day");
  if (elapsed < YEAR) return RELATIVE.format(-Math.floor(elapsed / MONTH), "month");
  return RELATIVE.format(-Math.floor(elapsed / YEAR), "year");
}

/** The full datetime behind the relative label — rides `title`. */
export function formatAbsoluteTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return "";
  return new Date(timestampMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Machine-readable form for `<time dateTime>`. Empty when the input is junk. */
export function toDateTimeAttribute(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) return "";
  return new Date(timestampMs).toISOString();
}
