// WHA-137 (A2): the ledger replay and its decision resolver.
//
// The golden case is WHA-130 from the reference ledger (`thewhatmatters/sagan`
// @ ab2cb8d): `decision.needed → decision.made(revise) → decision.needed(round
// 3)`. Any resolver that asks "does a decision.made exist for this gate" reports
// it answered, and the one ticket actually waiting on a human vanishes from the
// Needs-you queue. T-001 alone cannot catch that — BOTH algorithms pass it —
// which is why the shapes below are copied from the real file rather than
// invented.
//
// Pure functions over strings; no DB, no network, no model calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyTimestamp, isoTimestampOf, parseLedger, projectLedger, readLedger, needsYou } from "./ledger.js";

const lines = (...rows: unknown[]): string =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** The decision spine of the reference ledger, verbatim in shape and order. */
const REAL_SHAPE = lines(
  { event: "lane.updated", ticket: "T-001", lane: "frontend", phase: "dispatched",
    builder: "frontend-claude-subagent",
    // Drift from before the agent-fleet → sagan rename: an absolute pack path
    // and a `.agent/` role path. Must not trip the parser.
    pack: ["/Users/digitalalchemist/Development/agent-fleet", "tickets/T-001.md", ".agent/roles/frontend.md"],
    ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "T-001", round: 1, critic: "critic-claude-fresh",
    verdict: "NEEDS_EVIDENCE", findings: 4, artifact_sha: "03f2d22", ts: "2026-08-06" },
  { event: "evidence.recorded", ticket: "T-001", sha: "03f2d2299976eeb269f0452ff111fbbb1e9ca5e4",
    verifier: "verify-claude", checks: [{}, {}, {}, {}, {}, {}, {}], overall: "PASS", not_verified: [] },
  { event: "decision.needed", ticket: "T-001", gate: "promote", state: "awaiting-promote",
    evidence_sha: "03f2d22", ts: "2026-08-06" },
  { event: "decision.made", ticket: "T-001", gate: "promote", decision: "promote", by: "randy", ts: "2026-08-06" },

  { event: "run.started", ticket: "WHA-131", store: "linear", pm: "claude-code-session", ts: "2026-08-06" },
  { event: "lane.updated", ticket: "WHA-131", lane: "design", phase: "dispatched", ts: "2026-08-06" },
  { event: "decision.needed", ticket: "WHA-131", gate: "art-direction-approval", state: "awaiting-randy", ts: "2026-08-06" },
  { event: "decision.made", ticket: "WHA-131", gate: "art-direction-approval", decision: "approve", by: "randy", ts: "2026-08-06" },

  { event: "decision.needed", ticket: "WHA-130", gate: "promote", state: "awaiting-randy",
    evidence_sha: "fee9144", ts: "2026-08-06" },
  { event: "decision.made", ticket: "WHA-130", gate: "promote", decision: "revise", by: "randy",
    findings: ["reads-as-slides-not-website", "no-navigation"],
    amendment: "AC2 continuous document + sticky mono index", ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "WHA-130", round: 3, critic: "critic-claude-fresh",
    verdict: "APPROVED", findings: 0, artifact_sha: "9be4459", ts: "2026-08-07" },
  { event: "decision.needed", ticket: "WHA-130", gate: "promote", state: "awaiting-randy",
    round: 3, evidence_sha: "9be4459", ts: "2026-08-07" },
);

const project = (text: string) => {
  const { events, unparseable } = parseLedger(text);
  return projectLedger(events, unparseable);
};
const ticket = (text: string, id: string) => {
  const t = project(text).tickets.find((x) => x.ticket === id);
  assert.ok(t, `no projection for ${id}`);
  return t;
};

test("GOLDEN: a gate reopened after being answered is still open", () => {
  const wha130 = ticket(REAL_SHAPE, "WHA-130");
  assert.equal(wha130.openDecisions.length, 1, "needed → made → needed must stay open");
  assert.equal(wha130.openDecisions[0]!.gate, "promote");
  assert.equal(wha130.openDecisions[0]!.round, 3);
  assert.equal(wha130.openDecisions[0]!.evidenceSha, "9be4459");
  // The superseded answer is not reported as the gate's state.
  assert.equal(wha130.resolvedDecisions.length, 0);
});

test("GOLDEN: an answered gate is not open", () => {
  const t001 = ticket(REAL_SHAPE, "T-001");
  assert.equal(t001.openDecisions.length, 0);
  assert.equal(t001.resolvedDecisions[0]?.decision, "promote");
  assert.equal(t001.resolvedDecisions[0]?.by, "randy");
});

test("Needs you is exactly the reopened ticket", () => {
  const waiting = needsYou(project(REAL_SHAPE)).map((t) => t.ticket);
  assert.deepEqual(waiting, ["WHA-130"]);
});

test("GOLDEN: the revise that reopened a gate survives in the history", () => {
  // WHA-137.1. `openDecisions` correctly reports only the round-3 request, but
  // the reason round 3 exists — a human answering `revise` with findings and an
  // AC amendment — is erased by last-event-wins. The inspector needs the why.
  const wha130 = ticket(REAL_SHAPE, "WHA-130");

  // The resolver is unchanged.
  assert.equal(wha130.openDecisions.length, 1);
  assert.equal(wha130.openDecisions[0]!.round, 3);
  assert.equal(wha130.resolvedDecisions.length, 0);

  // …and nothing is collapsed in the history.
  assert.deepEqual(
    wha130.decisionHistory.map((d) => d.kind),
    ["needed", "made", "needed"],
    "history must not be last-only",
  );
  const revise = wha130.decisionHistory[1]!;
  assert.equal(revise.decision, "revise");
  assert.equal(revise.by, "randy");
  assert.deepEqual(revise.findings, ["reads-as-slides-not-website", "no-navigation"]);
  assert.equal(revise.amendment, "AC2 continuous document + sticky mono index");
  // Each entry carries the fields the inspector renders.
  assert.equal(wha130.decisionHistory[0]!.evidenceSha, "fee9144");
  assert.equal(wha130.decisionHistory[2]!.evidenceSha, "9be4459");
  assert.equal(wha130.decisionHistory[2]!.state, "awaiting-randy");
  assert.equal(wha130.decisionHistory[2]!.round, 3);
});

test("history keeps gates in one sequence without mixing their payloads", () => {
  const two = lines(
    { event: "decision.needed", ticket: "X-6", gate: "art-direction-approval", state: "awaiting-randy" },
    { event: "decision.made", ticket: "X-6", gate: "art-direction-approval", decision: "approve", by: "randy" },
    { event: "decision.needed", ticket: "X-6", gate: "promote", state: "awaiting-randy" },
  );
  const t = ticket(two, "X-6");
  assert.deepEqual(
    t.decisionHistory.map((d) => `${d.gate}:${d.kind}`),
    ["art-direction-approval:needed", "art-direction-approval:made", "promote:needed"],
  );
  // Resolver still answers per gate, independently.
  assert.deepEqual(t.openDecisions.map((d) => d.gate), ["promote"]);
  assert.deepEqual(t.resolvedDecisions.map((d) => d.gate), ["art-direction-approval"]);
});

test("history is empty for a ticket with no gates, not undefined", () => {
  const t = ticket(lines({ event: "run.started", ticket: "X-7", store: "linear" }), "X-7");
  assert.deepEqual(t.decisionHistory, []);
});

test("a revise carries its findings and its AC amendment", () => {
  // The most interesting event in the ledger: the human rewriting the contract
  // mid-run. A two-verb approve/reject model cannot represent it.
  const reopened = lines(
    { event: "decision.needed", ticket: "X-1", gate: "promote", state: "awaiting-randy" },
    { event: "decision.made", ticket: "X-1", gate: "promote", decision: "revise", by: "randy",
      findings: ["a", "b"], amendment: "AC2 rewritten" },
  );
  const t = ticket(reopened, "X-1");
  assert.deepEqual(t.resolvedDecisions[0]?.findings, ["a", "b"]);
  assert.equal(t.resolvedDecisions[0]?.amendment, "AC2 rewritten");
});

test("`findings` as a count never leaks out of a critique verdict", () => {
  // Same key, different type per event type: a number on critique.verdict, an
  // array on decision.made. Merging the two shapes would crash or lie.
  const t = ticket(REAL_SHAPE, "T-001");
  assert.equal(t.verdict, "NEEDS_EVIDENCE");
  for (const d of t.resolvedDecisions) assert.ok(Array.isArray(d.findings));
});

test("gates are independent — answering one does not answer another", () => {
  const two = lines(
    { event: "decision.needed", ticket: "X-2", gate: "art-direction-approval", state: "awaiting-randy" },
    { event: "decision.needed", ticket: "X-2", gate: "promote", state: "awaiting-randy" },
    { event: "decision.made", ticket: "X-2", gate: "promote", decision: "promote", by: "randy" },
  );
  const t = ticket(two, "X-2");
  assert.deepEqual(t.openDecisions.map((d) => d.gate), ["art-direction-approval"]);
  assert.deepEqual(t.resolvedDecisions.map((d) => d.gate), ["promote"]);
});

test("an unknown event type is skipped and counted, never fatal", () => {
  const withFuture = REAL_SHAPE + lines({ event: "quorum.reached", ticket: "T-001", votes: 3 });
  const p = project(withFuture);
  assert.equal(p.skipped.unknownType, 1);
  assert.equal(needsYou(p).length, 1, "the rest of the ledger still projects");
});

test("a torn final line is skipped and everything before it survives", () => {
  // What a process killed mid-append leaves behind. A reader that throws here
  // blanks the surface at exactly the moment someone needs to see the run.
  const torn = REAL_SHAPE + '{"event":"decision.needed","ticket":"WHA-131","ga';
  const p = project(torn);
  assert.equal(p.skipped.unparseable, 1);
  assert.deepEqual(needsYou(p).map((t) => t.ticket), ["WHA-130"]);
});

test("a JSON line that is not an object is skipped, not folded", () => {
  const p = project(lines({ event: "run.started", ticket: "X-3" }) + "[1,2,3]\n\"hello\"\n");
  assert.equal(p.skipped.unparseable, 2);
  assert.equal(p.tickets.length, 1);
});

test("an event with no ticket is counted, not attributed to a neighbour", () => {
  const p = project(
    lines({ event: "run.started", ticket: "X-4" }, { event: "lane.updated", lane: "frontend" }),
  );
  assert.equal(p.skipped.noTicket, 1);
  assert.equal(p.tickets.length, 1);
});

test("lanes are open-ended strings", () => {
  // `design` appears in the reference ledger with no file under .sagan/roles/.
  assert.equal(ticket(REAL_SHAPE, "WHA-131").lane, "design");
});

test("last lane and phase win; highest round is kept", () => {
  const t = ticket(
    lines(
      { event: "lane.updated", ticket: "X-5", lane: "frontend", phase: "dispatched", round: 1 },
      { event: "lane.updated", ticket: "X-5", lane: "frontend", phase: "built", round: 1 },
      { event: "critique.verdict", ticket: "X-5", round: 2, verdict: "REVISE", findings: 3 },
      { event: "lane.updated", ticket: "X-5", lane: "verify", phase: "dispatched" },
    ),
    "X-5",
  );
  assert.equal(t.lane, "verify");
  assert.equal(t.phase, "dispatched");
  assert.equal(t.round, 2);
  assert.equal(t.verdict, "REVISE");
});

test("evidence is collected with its sha, verifier and check count", () => {
  const t = ticket(REAL_SHAPE, "T-001");
  assert.equal(t.evidence.length, 1);
  assert.equal(t.evidence[0]?.overall, "PASS");
  assert.equal(t.evidence[0]?.checks, 7);
  assert.match(t.evidence[0]?.sha ?? "", /^03f2d229/);
});

test("a missing ts does not break the timestamp range", () => {
  // Real `evidence.recorded` rows sometimes carry no ts at all, and ts is a
  // day-granular string — it can never be the ordering key.
  const t = ticket(REAL_SHAPE, "T-001");
  assert.equal(t.firstTs, "2026-08-06");
  assert.equal(t.lastTs, "2026-08-06");
  assert.equal(t.eventCount, 5);
});

test("a ledger that does not exist projects empty rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-ledger-"));
  const p = readLedger(path.join(dir, "nope", "events.jsonl"));
  assert.deepEqual(p.tickets, []);
  assert.equal(p.skipped.unparseable, 0);
});

test("readLedger replays a real file from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-ledger-real-"));
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, REAL_SHAPE);
  assert.deepEqual(needsYou(readLedger(file)).map((t) => t.ticket), ["WHA-130"]);
});

test("WHA-225: a full ISO-8601 timestamp is classified exact", () => {
  const c = classifyTimestamp({ event: "lane.updated", ts: "2026-08-08T16:58:52Z" });
  assert.equal(c.ts, "2026-08-08T16:58:52Z");
  assert.equal(c.isoTs, "2026-08-08T16:58:52Z");
  assert.equal(c.tsKind, "exact");
  assert.equal(c.disagreement, false);
});

test("WHA-225: a day-granular timestamp is classified day with no instant", () => {
  const c = classifyTimestamp({ event: "lane.updated", ts: "2026-08-06" });
  assert.equal(c.ts, "2026-08-06");
  assert.equal(c.isoTs, null);
  assert.equal(c.tsKind, "day");
});

test("WHA-225: missing both timestamp fields is classified none", () => {
  const c = classifyTimestamp({ event: "evidence.recorded" });
  assert.equal(c.ts, null);
  assert.equal(c.isoTs, null);
  assert.equal(c.tsKind, "none");
});

test("WHA-225: a day `ts` does not shadow a precise `timestamp`", () => {
  const c = classifyTimestamp({
    event: "lane.updated",
    ts: "2026-08-10",
    timestamp: "2026-08-08T16:58:52Z",
  });
  assert.equal(c.isoTs, "2026-08-08T16:58:52Z");
  assert.equal(c.tsKind, "exact");
  assert.equal(c.disagreement, false, "a day-granular `ts` does not parse as ISO, so there is no disagreement");
});

test("WHA-225: the raw `ts` field follows the field that won so it never disagrees with `tsKind`", () => {
  const c = classifyTimestamp({
    event: "lane.updated",
    ts: "2026-08-10",
    timestamp: "2026-08-10T20:38:00Z",
  });
  assert.equal(c.ts, "2026-08-10T20:38:00Z");
  assert.equal(c.isoTs, "2026-08-10T20:38:00Z");
  assert.equal(c.tsKind, "exact");
});

test("WHA-225: disagreeing ISO `ts` and `timestamp` prefer `timestamp` and count the mismatch", () => {
  const c = classifyTimestamp({
    event: "lane.updated",
    ts: "2026-08-10T10:00:00Z",
    timestamp: "2026-08-08T16:58:52Z",
  });
  assert.equal(c.isoTs, "2026-08-08T16:58:52Z");
  assert.equal(c.disagreement, true);

  const p = projectLedger([
    { event: "lane.updated", ticket: "X-8", ts: "2026-08-10T10:00:00Z", timestamp: "2026-08-08T16:58:52Z" },
  ]);
  assert.equal(p.timestampMismatch, 1);
  const t = p.tickets[0]!;
  assert.equal(t.firstIsoTs, "2026-08-08T16:58:52Z");
  assert.equal(t.lastIsoTs, "2026-08-08T16:58:52Z");
});

test("WHA-225: projection tracks first/last ISO timestamps separately from raw strings", () => {
  const p = projectLedger([
    { event: "lane.updated", ticket: "X-9", ts: "2026-08-06" },
    { event: "lane.updated", ticket: "X-9", timestamp: "2026-08-08T16:58:52Z" },
    { event: "lane.updated", ticket: "X-9", ts: "2026-08-10" },
  ]);
  const t = p.tickets[0]!;
  assert.equal(t.firstTs, "2026-08-06");
  assert.equal(t.lastTs, "2026-08-10");
  assert.equal(t.firstTsKind, "day");
  assert.equal(t.lastTsKind, "day");
  assert.equal(t.firstIsoTs, "2026-08-08T16:58:52Z");
  assert.equal(t.lastIsoTs, "2026-08-08T16:58:52Z");
});

test("WHA-225: decision history carries timestamp classification", () => {
  const p = projectLedger([
    { event: "decision.needed", ticket: "X-10", gate: "promote", state: "awaiting-randy", ts: "2026-08-06" },
    { event: "decision.made", ticket: "X-10", gate: "promote", decision: "approve", by: "randy", timestamp: "2026-08-08T16:58:52Z" },
  ]);
  const t = p.tickets[0]!;
  assert.equal(t.decisionHistory[0]!.tsKind, "day");
  assert.equal(t.decisionHistory[0]!.isoTs, null);
  assert.equal(t.decisionHistory[1]!.tsKind, "exact");
  assert.equal(t.decisionHistory[1]!.isoTs, "2026-08-08T16:58:52Z");
});

test("WHA-225: isoTimestampOf helper returns the preferred instant", () => {
  assert.equal(
    isoTimestampOf({ event: "lane.updated", ts: "2026-08-10", timestamp: "2026-08-08T16:58:52Z" }),
    "2026-08-08T16:58:52Z",
  );
});
