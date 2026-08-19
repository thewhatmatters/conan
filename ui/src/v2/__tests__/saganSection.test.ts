import { describe, expect, it } from "vitest";
import { sectionFor, type SaganSection } from "../lib/saganSection.ts";
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";

/**
 * WHA-169 — the Overview's section rule as a table.
 *
 * Every AC here is "given verdict X and lane Y, which bucket?", so this file is
 * a table and nothing else; the rendering side lives in `V2SaganSurface.test.tsx`.
 *
 * The rows marked LEDGER are not invented. They are the real projections of
 * `.sagan/ledger/events.jsonl` at `5cd617a`, read back through
 * `projectLedger()`, so this file fails if the rule regresses against the
 * actual board rather than against a convenient fiction.
 */
const TERMINAL_LANES = ["done", "merged"];
const TERMINAL_PHASES = ["done", "merged", "complete", "completed"];
const isTerminalPosition = (lane: string | null, phase: string | null): boolean =>
  TERMINAL_LANES.includes(lane?.toLowerCase() ?? "") || TERMINAL_PHASES.includes(phase?.toLowerCase() ?? "");

const summary = (patch: Partial<SaganRunSummary>): SaganRunSummary => {
  const lane = patch.lane ?? null;
  const phase = patch.phase ?? null;
  const terminal = isTerminalPosition(lane, phase);
  return {
    id: "T-000",
    ticket: "T-000",
    lane,
    phase,
    round: 1,
    verdict: null,
    agent: null,
    openDecisions: [],
    needsYou: false,
    laneCount: 1,
    verdictCount: 0,
    evidenceCount: 0,
    firstTs: "2026-08-10",
    lastTs: "2026-08-10",
    firstIsoTs: null,
    lastIsoTs: null,
    eventCount: 1,
    title: null,
    statusNote: null,
    completion: terminal
      ? { state: "done", source: "ledger", conflict: null }
      : { state: "open", source: null, conflict: null },
    ...patch,
  };
};

/** A live lane per verdict — the station that verdict actually hands work to —
 *  and the one terminal lane the ledger ever writes, `done · merged`. */
const table: Array<[string | null, string | null, string | null, SaganSection]> = [
  // ── each verdict against a LIVE lane (AC5) ──────────────────────────────
  [null, "frontend", "building", "Running now"],
  ["APPROVED", "verify", "verifying", "Running now"],
  // REVISE loops back to build inside the round cap — a station that runs.
  ["REVISE", "frontend", "building", "Running now"],
  // THE TICKET'S CASE: a verifier is executing right now (AC1, AC2).
  ["NEEDS_EVIDENCE", "verify", "verifying", "Running now"],
  // The one verdict that stops dead and needs a human.
  ["ESCALATE", "critique", "critique", "Blocked"],

  // ── each verdict against a FINISHED lane (AC5) ──────────────────────────
  [null, "done", "merged", "Recently completed"],
  ["APPROVED", "done", "merged", "Recently completed"],
  // The live broken case: WHA-140's shape. A stale verdict cannot un-merge a
  // merged run.
  ["REVISE", "done", "merged", "Recently completed"],
  ["NEEDS_EVIDENCE", "done", "merged", "Recently completed"],
  // Stated consequence of ordering position before verdict (AC4): a run that
  // escalated and then reads `done` is a run somebody acted on.
  ["ESCALATE", "done", "merged", "Recently completed"],
];

describe("sectionFor — verdict against lane (WHA-169)", () => {
  it.each(table)("verdict %s on lane %s/%s renders under %s", (verdict, lane, phase, expected) => {
    expect(sectionFor(summary({ verdict, lane, phase }))).toBe(expected);
  });

  it("puts only ESCALATE and an explicit block marker under Blocked (AC1)", () => {
    for (const verdict of ["APPROVED", "REVISE", "NEEDS_EVIDENCE", null]) {
      expect(sectionFor(summary({ verdict, lane: "critique", phase: "critique" }))).not.toBe("Blocked");
    }
    expect(sectionFor(summary({ verdict: "ESCALATE", lane: "critique", phase: "critique" }))).toBe("Blocked");
    // A block in the POSITION, not the verdict — this is what survives.
    expect(sectionFor(summary({ lane: "frontend", phase: "blocked" }))).toBe("Blocked");
    expect(sectionFor(summary({ lane: "blocked", phase: null }))).toBe("Blocked");
    expect(sectionFor(summary({ lane: "frontend", phase: "blocked-on-review" }))).toBe("Blocked");
  });

  it("keeps an open decision gate ahead of every other signal", () => {
    const gate = [{ gate: "promote", state: "awaiting-randy", evidenceSha: "07c9ac1", round: 2 }];
    for (const verdict of ["ESCALATE", "REVISE", "NEEDS_EVIDENCE", "APPROVED", null]) {
      expect(sectionFor(summary({ verdict, lane: "promote", phase: "needs-you", openDecisions: gate })))
        .toBe("Needs you");
    }
    // …including over a terminal lane, which is checked second.
    expect(sectionFor(summary({ lane: "done", phase: "merged", openDecisions: gate }))).toBe("Needs you");
  });

  it("matches the queued vocabulary exactly and treats anything else as running", () => {
    expect(sectionFor(summary({ lane: "queued", phase: null }))).toBe("Up next");
    expect(sectionFor(summary({ lane: "backlog", phase: null }))).toBe("Up next");
    expect(sectionFor(summary({ lane: null, phase: "pending" }))).toBe("Up next");
    // An unknown lane is work in progress, never a run dropped off the board.
    expect(sectionFor(summary({ lane: "docs-writer", phase: "dispatched" }))).toBe("Running now");
    expect(sectionFor(summary({ lane: null, phase: null }))).toBe("Running now");
  });

  it("reads lane, phase and verdict case-insensitively", () => {
    expect(sectionFor(summary({ lane: "DONE", phase: "MERGED" }))).toBe("Recently completed");
    expect(sectionFor(summary({ verdict: "escalate", lane: "critique", phase: "critique" }))).toBe("Blocked");
  });

  it("files unknown completion under Recently completed with a disagreement marker (WHA-167)", () => {
    expect(sectionFor(summary({ completion: { state: "unknown", source: "git", conflict: { git: true, ticketFile: "ready-for-qa" } } }))).toBe("Recently completed");
    expect(sectionFor(summary({ completion: { state: "unknown", source: null, conflict: { git: false, ticketFile: "done" } } }))).toBe("Recently completed");
  });
});

/**
 * LEDGER — the projections of the real `.sagan/ledger/events.jsonl` at
 * `5cd617a`, field for field as `projectLedger()` returns them.
 */
const LEDGER_ROWS: Array<[string, SaganSection, SaganRunSummary]> = [
  // The live broken case. Merged Aug 8; its last critique is the round-1
  // REVISE that caused the revision which shipped.
  [
    "WHA-140",
    "Recently completed",
    summary({
      id: "WHA-140",
      ticket: "WHA-140",
      lane: "done",
      phase: "merged",
      round: 1,
      verdict: "REVISE",
      firstTs: null,
      lastTs: null,
      laneCount: 1,
      verdictCount: 1,
      evidenceCount: 1,
      eventCount: 4,
    }),
  ],
  // Correct before this change; must stay correct.
  [
    "WHA-125",
    "Recently completed",
    summary({
      id: "WHA-125",
      ticket: "WHA-125",
      lane: "done",
      phase: "merged",
      round: 2,
      verdict: "APPROVED",
      agent: { name: "dijkstra-r2", role: "critic" },
      laneCount: 7,
      verdictCount: 2,
      evidenceCount: 1,
      eventCount: 17,
    }),
  ],
  // The null path — merged with no verdict ever recorded.
  [
    "WHA-141",
    "Recently completed",
    summary({ id: "WHA-141", ticket: "WHA-141", lane: "done", phase: "merged", round: 1, firstTs: null, lastTs: null, laneCount: 2, evidenceCount: 1, eventCount: 5 }),
  ],
  [
    "WHA-142",
    "Recently completed",
    summary({ id: "WHA-142", ticket: "WHA-142", lane: "done", phase: "merged", round: 1, firstTs: "2026-08-08T14:48:26Z", lastTs: "2026-08-08T14:48:26Z", laneCount: 3, evidenceCount: 1, eventCount: 7 }),
  ],
  [
    "WHA-143",
    "Recently completed",
    summary({ id: "WHA-143", ticket: "WHA-143", lane: "done", phase: "merged", round: null, firstTs: "2026-08-08T15:07:46Z", lastTs: "2026-08-10", laneCount: 2, eventCount: 2 }),
  ],
  // The in-flight case. It no longer exists in the ledger — WHA-125 merged —
  // so it is replayed from the same file truncated at its `verify · verifying`
  // lane.updated: the moment Randy watched the board call it Blocked while
  // hamilton was executing.
  [
    "WHA-125 mid-verify (round 1)",
    "Running now",
    summary({
      id: "WHA-125",
      ticket: "WHA-125",
      lane: "verify",
      phase: "verifying",
      round: 1,
      verdict: "NEEDS_EVIDENCE",
      agent: { name: "hamilton", role: "verifier" },
      laneCount: 4,
      verdictCount: 1,
      eventCount: 10,
    }),
  ],
];

describe("sectionFor — against the real ledger at 5cd617a", () => {
  it.each(LEDGER_ROWS)("%s renders under %s", (_label, expected, run) => {
    expect(sectionFor(run)).toBe(expected);
  });

  it("leaves the real board with nothing under Blocked", () => {
    const blocked = LEDGER_ROWS.filter(([, , run]) => sectionFor(run) === "Blocked").map(([label]) => label);
    expect(blocked).toEqual([]);
  });
});
