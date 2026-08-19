import type { SaganRunSummary } from "../../../../src/sagan/api.ts";
import type { SaganSection } from "./saganSection.ts";

/**
 * WHA-229 — lane distribution + section ordering for the Sagan Overview.
 *
 * Lanes are open-ended strings from the projection (AC1). A preferred display
 * order covers the lanes the design mocks name; anything else still renders,
 * appended after the preferred ones in first-seen order. Every run lands in
 * exactly one bucket so counts sum to the total (AC2).
 */

/** Preferred lane order from the Overview mock. Unknown lanes append after. */
export const PREFERRED_LANE_ORDER = [
  "frontend",
  "critique",
  "backend",
  "verify",
  "design",
  "promote",
  "promote gate",
  "backlog",
  "build",
  "shipped",
  "done",
  "merged",
] as const;

export const UNASSIGNED_LANE = "Unassigned";

export type SectionOrderingLabel = "OLDEST FIRST" | "NEWEST FIRST" | "QUEUE ORDER";

export interface LaneCount {
  /** Raw lane key used for grouping (lowercase for known; Unassigned sentinel). */
  key: string;
  /** Display label shown next to the bar. */
  label: string;
  count: number;
}

export interface LaneDistribution {
  lanes: LaneCount[];
  total: number;
}

/** Grouping key for a run's current lane. Null/empty → Unassigned. */
export function laneKey(run: Pick<SaganRunSummary, "lane">): string {
  const raw = run.lane?.trim();
  return raw ? raw : UNASSIGNED_LANE;
}

/** Title-case a lane string for display (`frontend` → `Frontend`). */
export function laneLabel(key: string): string {
  if (key === UNASSIGNED_LANE) return UNASSIGNED_LANE;
  return key.replace(/\b[\p{L}\p{N}]/gu, (ch) => ch.toUpperCase());
}

/**
 * One ProgressBar row per distinct current lane, plus the total.
 * Preferred lanes keep mock order; any other lane still appears (AC1).
 */
export function laneDistribution(runs: readonly SaganRunSummary[]): LaneDistribution {
  const counts = new Map<string, number>();
  const firstSeen: string[] = [];
  for (const run of runs) {
    const key = laneKey(run);
    if (!counts.has(key)) firstSeen.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const preferredIndex = new Map<string, number>(
    PREFERRED_LANE_ORDER.map((lane, index) => [lane, index]),
  );

  const keys = [...counts.keys()].sort((a, b) => {
    if (a === UNASSIGNED_LANE && b !== UNASSIGNED_LANE) return 1;
    if (b === UNASSIGNED_LANE && a !== UNASSIGNED_LANE) return -1;
    const aPref = preferredIndex.get(a.toLowerCase());
    const bPref = preferredIndex.get(b.toLowerCase());
    if (aPref != null && bPref != null) return aPref - bPref;
    if (aPref != null) return -1;
    if (bPref != null) return 1;
    return firstSeen.indexOf(a) - firstSeen.indexOf(b);
  });

  const lanes: LaneCount[] = keys.map((key) => ({
    key,
    label: laneLabel(key),
    count: counts.get(key)!,
  }));

  return { lanes, total: runs.length };
}

/** The ordering label shown in section chrome — must match the comparator. */
export function orderingLabelFor(section: SaganSection): SectionOrderingLabel {
  switch (section) {
    case "Needs you":
    case "Blocked":
      return "OLDEST FIRST";
    case "Running now":
    case "Recently completed":
      return "NEWEST FIRST";
    case "Up next":
      return "QUEUE ORDER";
  }
}

function isoMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Oldest-first by `firstIsoTs`; missing timestamps sort last; ticket id tiebreak. */
export function compareOldestFirst(a: SaganRunSummary, b: SaganRunSummary): number {
  const aMs = isoMs(a.firstIsoTs);
  const bMs = isoMs(b.firstIsoTs);
  if (aMs == null && bMs == null) return a.ticket.localeCompare(b.ticket);
  if (aMs == null) return 1;
  if (bMs == null) return -1;
  return aMs - bMs || a.ticket.localeCompare(b.ticket);
}

/** Newest-first by `lastIsoTs`; missing timestamps sort last; ticket id tiebreak. */
export function compareNewestFirst(a: SaganRunSummary, b: SaganRunSummary): number {
  const aMs = isoMs(a.lastIsoTs);
  const bMs = isoMs(b.lastIsoTs);
  if (aMs == null && bMs == null) return a.ticket.localeCompare(b.ticket);
  if (aMs == null) return 1;
  if (bMs == null) return -1;
  return bMs - aMs || a.ticket.localeCompare(b.ticket);
}

/**
 * Queue order = FIFO by when the run first appeared (`firstIsoTs`).
 * Same clock as oldest-first; separate export so the label cannot drift from
 * the comparator the section actually uses (WHA-229 AC3).
 */
export function compareQueueOrder(a: SaganRunSummary, b: SaganRunSummary): number {
  return compareOldestFirst(a, b);
}

export function comparatorFor(section: SaganSection): (a: SaganRunSummary, b: SaganRunSummary) => number {
  switch (orderingLabelFor(section)) {
    case "OLDEST FIRST":
      return compareOldestFirst;
    case "NEWEST FIRST":
      return compareNewestFirst;
    case "QUEUE ORDER":
      return compareQueueOrder;
  }
}

/** Sort a section's rows with the comparator its ordering label claims. */
export function sortRunsForSection(
  section: SaganSection,
  runs: readonly SaganRunSummary[],
): SaganRunSummary[] {
  return [...runs].sort(comparatorFor(section));
}
