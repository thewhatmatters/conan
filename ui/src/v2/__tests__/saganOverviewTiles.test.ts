import { describe, expect, it } from "vitest";
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";
import { sectionFor } from "../lib/saganSection.ts";
import {
  decisionHeadline,
  overviewTiles,
  runningSplit,
  sectionForTile,
} from "../lib/saganOverviewTiles.ts";

const run = (patch: Partial<SaganRunSummary>): SaganRunSummary => ({
  id: patch.id ?? patch.ticket ?? "WHA-1",
  ticket: patch.ticket ?? patch.id ?? "WHA-1",
  lane: "lane" in patch ? (patch.lane ?? null) : "frontend",
  phase: patch.phase ?? "building",
  round: patch.round ?? 1,
  verdict: patch.verdict ?? null,
  agent: patch.agent ?? null,
  openDecisions: patch.openDecisions ?? [],
  needsYou: patch.needsYou ?? (patch.openDecisions?.length ?? 0) > 0,
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

describe("sectionForTile (WHA-226 AC1 label binding)", () => {
  it("binds each tile label to the section it names — Blocked, not Halted", () => {
    expect(sectionForTile("needs-you")).toBe("Needs you");
    expect(sectionForTile("running")).toBe("Running now");
    expect(sectionForTile("blocked")).toBe("Blocked");
  });
});

describe("decisionHeadline (WHA-226)", () => {
  it("uses a distinct calm state at zero — not a pluralised 0", () => {
    expect(decisionHeadline(0)).toBe("Nothing needs you right now.");
    expect(decisionHeadline(1)).toBe("1 decision is waiting on you");
    expect(decisionHeadline(2)).toBe("2 decisions are waiting on you");
  });
});

describe("overviewTiles (WHA-226 AC1)", () => {
  it("keeps each tile count equal to the sectionFor bucket as a run moves", () => {
    // Start Needs-you (open gate).
    let runs = [
      run({
        id: "A",
        ticket: "A",
        openDecisions: [{ gate: "promote", state: "awaiting", evidenceSha: null, round: 1 }],
      }),
      run({ id: "B", ticket: "B", lane: "frontend", phase: "building" }),
      run({ id: "C", ticket: "C", lane: "blocked", phase: "halted", verdict: "ESCALATE" }),
    ];
    let tiles = overviewTiles(runs);
    expect(tiles.tiles.map((t) => [t.label, t.count])).toEqual([
      ["Needs you", 1],
      ["Running", 1],
      ["Blocked", 1],
    ]);
    expect(runs.filter((r) => sectionFor(r) === "Needs you")).toHaveLength(1);
    expect(runs.filter((r) => sectionFor(r) === "Running now")).toHaveLength(1);
    expect(runs.filter((r) => sectionFor(r) === "Blocked")).toHaveLength(1);

    // Clear the gate → A drops into Running now (frontend/building).
    runs = [
      run({ id: "A", ticket: "A", lane: "frontend", phase: "building", openDecisions: [] }),
      run({ id: "B", ticket: "B", lane: "frontend", phase: "building" }),
      run({ id: "C", ticket: "C", lane: "blocked", phase: "halted", verdict: "ESCALATE" }),
    ];
    tiles = overviewTiles(runs);
    expect(tiles.tiles.map((t) => [t.id, t.count])).toEqual([
      ["needs-you", 0],
      ["running", 2],
      ["blocked", 1],
    ]);
    expect(runs.filter((r) => sectionFor(r) === "Needs you")).toHaveLength(0);
    expect(runs.filter((r) => sectionFor(r) === "Running now")).toHaveLength(2);
    expect(runs.filter((r) => sectionFor(r) === "Blocked")).toHaveLength(1);
  });

  it("splits Running as n build · n verify that always sum to the tile (AC3)", () => {
    const runs = [
      run({ id: "B1", ticket: "B1", lane: "frontend", phase: "building" }),
      run({ id: "V1", ticket: "V1", lane: "verify", phase: "delta-dispatched" }),
      run({ id: "C1", ticket: "C1", lane: "critique", phase: "dispatched" }),
    ];
    const tiles = overviewTiles(runs);
    const running = tiles.tiles.find((t) => t.id === "running")!;
    expect(running.count).toBe(3);
    expect(running.detail).toBe("2 build · 1 verify");
    const split = runningSplit(runs.filter((r) => sectionFor(r) === "Running now"));
    expect(split.build + split.verify).toBe(running.count);
  });

  it("pins headline/tile divergence: one run with two open gates (AC2a)", () => {
    const runs = [
      run({
        id: "MULTI",
        ticket: "MULTI",
        openDecisions: [
          { gate: "promote", state: "awaiting", evidenceSha: null, round: 2 },
          { gate: "art-direction-approval", state: "awaiting", evidenceSha: null, round: 1 },
        ],
      }),
    ];
    const tiles = overviewTiles(runs);
    expect(tiles.decisionCount).toBe(2);
    expect(tiles.headline).toBe("2 decisions are waiting on you");
    const needsYou = tiles.tiles.find((t) => t.id === "needs-you")!;
    expect(needsYou.count).toBe(1);
    // Deliberate divergence — do not "fix" by making these agree.
    expect(tiles.decisionCount).not.toBe(needsYou.count);
  });

  it("renders a zero-state on every tile and a calm headline at empty (AC2)", () => {
    const tiles = overviewTiles([]);
    expect(tiles.headline).toBe("Nothing needs you right now.");
    expect(tiles.decisionCount).toBe(0);
    expect(tiles.tiles).toEqual([
      { id: "needs-you", label: "Needs you", count: 0, detail: "Nothing waiting" },
      { id: "running", label: "Running", count: 0, detail: "0 build · 0 verify" },
      { id: "blocked", label: "Blocked", count: 0, detail: "Nothing blocked" },
    ]);
  });

  it("never labels a tile Halted — Blocked is the section name", () => {
    const tiles = overviewTiles([
      run({ id: "X", ticket: "X", lane: "blocked", phase: "halted", verdict: "ESCALATE" }),
    ]);
    expect(tiles.tiles.map((t) => t.label)).toEqual(["Needs you", "Running", "Blocked"]);
    expect(tiles.tiles.some((t) => /halted/i.test(t.label))).toBe(false);
    expect(tiles.tiles.find((t) => t.id === "blocked")!.count).toBe(1);
  });
});
