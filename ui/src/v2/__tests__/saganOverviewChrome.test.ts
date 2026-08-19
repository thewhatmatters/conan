import { describe, expect, it } from "vitest";
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";
import {
  compareNewestFirst,
  compareOldestFirst,
  compareQueueOrder,
  laneDistribution,
  laneKey,
  orderingLabelFor,
  sortRunsForSection,
  UNASSIGNED_LANE,
} from "../lib/saganOverviewChrome.ts";
import { SAGAN_SECTIONS, type SaganSection } from "../lib/saganSection.ts";

const run = (patch: Partial<SaganRunSummary>): SaganRunSummary => ({
  id: patch.id ?? patch.ticket ?? "WHA-1",
  ticket: patch.ticket ?? patch.id ?? "WHA-1",
  // `??` would collapse an explicit `null` lane into the default — AC1 needs null.
  lane: "lane" in patch ? (patch.lane ?? null) : "frontend",
  phase: patch.phase ?? "building",
  round: patch.round ?? 1,
  verdict: patch.verdict ?? null,
  agent: patch.agent ?? null,
  openDecisions: patch.openDecisions ?? [],
  needsYou: patch.needsYou ?? false,
  laneCount: patch.laneCount ?? 1,
  verdictCount: patch.verdictCount ?? 0,
  evidenceCount: patch.evidenceCount ?? 0,
  firstTs: patch.firstTs ?? null,
  lastTs: patch.lastTs ?? null,
  firstIsoTs: patch.firstIsoTs ?? null,
  lastIsoTs: patch.lastIsoTs ?? null,
  eventCount: patch.eventCount ?? 1,
  title: patch.title ?? null,
  statusNote: patch.statusNote ?? null,
  completion: patch.completion ?? { state: "open", source: null, conflict: null },
});

describe("laneDistribution (WHA-229 AC1/AC2)", () => {
  it("still renders a synthesised lane absent from the preferred list, with its count", () => {
    const dist = laneDistribution([
      run({ id: "A", ticket: "A", lane: "frontend" }),
      run({ id: "B", ticket: "B", lane: "persona-test" }),
      run({ id: "C", ticket: "C", lane: "persona-test" }),
    ]);
    const synthetic = dist.lanes.find((lane) => lane.key === "persona-test");
    expect(synthetic).toEqual({ key: "persona-test", label: "Persona-Test", count: 2 });
    expect(dist.lanes.map((lane) => lane.key)).toContain("persona-test");
    expect(dist.lanes.map((lane) => lane.key)).toContain("frontend");
  });

  it("sums lane counts to the total run count, including Unassigned", () => {
    const runs = [
      run({ id: "A", ticket: "A", lane: "frontend" }),
      run({ id: "B", ticket: "B", lane: "critique" }),
      run({ id: "C", ticket: "C", lane: null }),
      run({ id: "D", ticket: "D", lane: "  " }),
    ];
    const dist = laneDistribution(runs);
    expect(dist.total).toBe(4);
    expect(dist.lanes.reduce((sum, lane) => sum + lane.count, 0)).toBe(dist.total);
    expect(laneKey(runs[2]!)).toBe(UNASSIGNED_LANE);
    expect(dist.lanes.at(-1)?.key).toBe(UNASSIGNED_LANE);
  });

  it("returns an empty lane list when there are zero runs (AC6 — no bar chart of zeros)", () => {
    expect(laneDistribution([])).toEqual({ lanes: [], total: 0 });
  });
});

describe("section ordering (WHA-229 AC3)", () => {
  const labels: Record<SaganSection, string> = {
    "Needs you": "OLDEST FIRST",
    "Running now": "NEWEST FIRST",
    "Up next": "QUEUE ORDER",
    Blocked: "OLDEST FIRST",
    "Recently completed": "NEWEST FIRST",
  };

  it.each(SAGAN_SECTIONS)("label for %s matches the locked map", (section) => {
    expect(orderingLabelFor(section)).toBe(labels[section]);
  });

  it("OLDEST FIRST sorts by firstIsoTs ascending even when input is reversed", () => {
    const newer = run({ id: "NEW", ticket: "NEW", firstIsoTs: "2026-08-10T12:00:00Z" });
    const older = run({ id: "OLD", ticket: "OLD", firstIsoTs: "2026-08-01T12:00:00Z" });
    // Deliberately wrong input order — newest first.
    expect(sortRunsForSection("Needs you", [newer, older]).map((r) => r.ticket)).toEqual(["OLD", "NEW"]);
    expect(compareOldestFirst(older, newer)).toBeLessThan(0);
  });

  it("NEWEST FIRST sorts by lastIsoTs descending even when input is reversed", () => {
    const olderTouch = run({ id: "A", ticket: "A", lastIsoTs: "2026-08-01T12:00:00Z" });
    const newerTouch = run({ id: "B", ticket: "B", lastIsoTs: "2026-08-10T12:00:00Z" });
    expect(sortRunsForSection("Running now", [olderTouch, newerTouch]).map((r) => r.ticket)).toEqual([
      "B",
      "A",
    ]);
    expect(compareNewestFirst(newerTouch, olderTouch)).toBeLessThan(0);
  });

  it("QUEUE ORDER uses the queue comparator (FIFO by firstIsoTs), not a label-only claim", () => {
    const late = run({ id: "LATE", ticket: "LATE", firstIsoTs: "2026-08-09T00:00:00Z" });
    const early = run({ id: "EARLY", ticket: "EARLY", firstIsoTs: "2026-08-02T00:00:00Z" });
    expect(sortRunsForSection("Up next", [late, early]).map((r) => r.ticket)).toEqual(["EARLY", "LATE"]);
    expect(compareQueueOrder(early, late)).toBe(compareOldestFirst(early, late));
  });
});
