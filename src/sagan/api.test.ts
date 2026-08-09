// WHA-140 (B2): the read API over the projection.
//
// Three things here are worth more than the rest:
//
//   1. PROJECT SCOPING. `resolveSaganProject` is the only door to a ledger, and
//      it opens onto exactly one folder — whether the id is a project row or a
//      path on disk. Two Sagan projects must never see each other's runs, an id
//      that names no project must not fall back to whatever project happens to
//      be open, and a ledger that is textually inside the root but symlinked
//      out of it must not be read.
//   2. The `:id` never touches the filesystem. A ticket id shaped like a path
//      traversal is a miss, not a read — asserted, because the day someone
//      "helpfully" joins the id onto a directory this is the test that fails.
//   3. The detail keeps the SEQUENCE the projection collapses. WHA-130 in the
//      reference ledger has three critique rounds and two verification shas;
//      last-one-wins is right for the Needs-you queue and wrong for the
//      inspector, so the plural lists are checked against the real counts.
//
// Real files on disk plus a throwaway SQLite database — env is pointed at a
// temp dir BEFORE the db module, which captures paths at import. Run with
// `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-sagan-api-"));
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = path.join(dataDir, "conan.db");

const {
  listSaganRuns,
  getSaganRun,
  resolveSaganProject,
  saganLedgerPath,
  ledgerWithinRoot,
} = await import("./api.js");
const { upsertChatProject } = await import("../agent/threads.js");

const lines = (...rows: unknown[]): string =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Trimmed from `thewhatmatters/sagan` @ ab2cb8d — shapes and order verbatim,
 *  including the two different `evidence.recorded` shapes (a verifier run with
 *  `checks[]`, and a producer run whose `artifacts` is an ARRAY on WHA-131 and
 *  a STRING on WHA-130) and WHA-130's `needed → made(revise) → needed(round 3)`
 *  gate. Anything invented here would be testing the test. */
const REFERENCE = lines(
  { event: "lane.updated", ticket: "T-001", lane: "frontend", phase: "dispatched",
    builder: "frontend-claude-subagent", pack: ["/abs/agent-fleet", "tickets/T-001.md"],
    ts: "2026-08-06" },
  { event: "lane.updated", ticket: "T-001", lane: "frontend", phase: "built",
    artifact: "src/index.html", flags: ["repo-path-ambiguity", "tagline-paraphrase"],
    ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "T-001", round: 1, critic: "critic-claude-fresh",
    verdict: "NEEDS_EVIDENCE", findings: 4, artifact_sha: "03f2d22", ts: "2026-08-06" },
  { event: "lane.updated", ticket: "T-001", lane: "verify", phase: "dispatched",
    verifier: "verify-claude", sha: "03f2d22", ts: "2026-08-06" },
  { event: "evidence.recorded", ticket: "T-001",
    sha: "03f2d2299976eeb269f0452ff111fbbb1e9ca5e4", verifier: "verify-claude",
    checks: [{ ac_ref: "AC1", result: "PASS" }, { ac_ref: "AC2", result: "PASS" }],
    overall: "PASS", not_verified: [] },
  { event: "critique.verdict", ticket: "T-001", round: 2, critic: "critic-claude-fresh",
    verdict: "APPROVED", findings: 0, artifact_sha: "03f2d22", ts: "2026-08-06" },
  { event: "decision.needed", ticket: "T-001", gate: "promote", state: "awaiting-promote",
    evidence_sha: "03f2d22", ts: "2026-08-06" },
  { event: "decision.made", ticket: "T-001", gate: "promote", decision: "promote",
    by: "randy", ts: "2026-08-06" },

  { event: "run.started", ticket: "WHA-131", store: "linear", pm: "claude-code-session",
    ts: "2026-08-06" },
  { event: "lane.updated", ticket: "WHA-131", lane: "design", phase: "dispatched",
    builder: "frontend-claude-subagent", pack: ".sagan/refs/wha-131-pack.md", ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "WHA-131", round: 1, critic: "critic-claude-fresh",
    verdict: "NEEDS_EVIDENCE", findings: 4, evidence_needed: "grid-overlay-on renders",
    ts: "2026-08-06" },
  { event: "evidence.recorded", ticket: "WHA-131", producer: "pm-render",
    artifacts: [".sagan/refs/wha-131-renders/light-grid-on.png",
      ".sagan/refs/wha-131-renders/dark-grid-on.png"],
    for: "AC5 grid-overlay + ink-alignment judgment", ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "WHA-131", round: 2, critic: "critic-claude-fresh",
    verdict: "APPROVED", findings: 4, blocking: 0, ts: "2026-08-06" },
  { event: "decision.needed", ticket: "WHA-131", gate: "art-direction-approval",
    state: "awaiting-randy", ts: "2026-08-06" },
  { event: "decision.made", ticket: "WHA-131", gate: "art-direction-approval",
    decision: "approve", by: "randy", ts: "2026-08-06" },

  { event: "lane.updated", ticket: "WHA-130", lane: "frontend", phase: "dispatched",
    builder: "frontend-claude-subagent", pack: ".sagan/refs/wha-130-pack.md",
    frame_contract: "design/wha-131-frame@392bd2b", ts: "2026-08-06" },
  { event: "lane.updated", ticket: "WHA-130", lane: "frontend", phase: "built",
    artifact: "site/", dist_bytes: 529968, flags: ["engraving-inner-scroll-375"],
    ts: "2026-08-06" },
  { event: "evidence.recorded", ticket: "WHA-130", producer: "pm-render",
    artifacts: ".sagan/refs/wha-130-renders/ (375+1280 x light+dark full-page)",
    note: "round-1 predictable evidence", ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "WHA-130", round: 1, critic: "critic-claude-fresh",
    verdict: "REVISE", findings: 6, high: 2, artifact_sha: "1aca52d", ts: "2026-08-06" },
  { event: "evidence.recorded", ticket: "WHA-130", sha: "1aca52d", verifier: "verify-claude",
    checks: [{ ac_ref: "AC1" }, { ac_ref: "AC2" }, { ac_ref: "AC3" }],
    overall: "PASS", not_verified: ["AC3/AC4 aesthetic fidelity", "cross-browser: Chromium only"],
    ts: "2026-08-06" },
  { event: "lane.updated", ticket: "WHA-130", lane: "frontend", phase: "revised", round: 2,
    artifact_sha: "fee9144", ts: "2026-08-06" },
  { event: "evidence.recorded", ticket: "WHA-130", sha: "fee9144", verifier: "verify-claude",
    delta_of: "1aca52d", checks: [{ ac_ref: "AC1-delta" }], overall: "PASS",
    not_verified: [], ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "WHA-130", round: 2, critic: "critic-claude-fresh",
    verdict: "APPROVED", findings: 2, blocking: 0, artifact_sha: "fee9144", ts: "2026-08-06" },
  { event: "decision.needed", ticket: "WHA-130", gate: "promote", state: "awaiting-randy",
    evidence_sha: "fee9144", ts: "2026-08-06" },
  { event: "decision.made", ticket: "WHA-130", gate: "promote", decision: "revise", by: "randy",
    findings: ["reads-as-slides-not-website", "no-navigation"],
    amendment: "AC2 continuous document + sticky mono index", ts: "2026-08-06" },
  { event: "lane.updated", ticket: "WHA-130", lane: "critique", phase: "dispatched",
    critic: "critic-claude-fresh", round: 3, ts: "2026-08-06" },
  { event: "critique.verdict", ticket: "WHA-130", round: 3, critic: "critic-claude-fresh",
    verdict: "APPROVED", findings: 5, blocking: 0, artifact_sha: "9be4459", ts: "2026-08-06" },
  { event: "decision.needed", ticket: "WHA-130", gate: "promote", state: "awaiting-randy",
    round: 3, evidence_sha: "9be4459", ts: "2026-08-06" },
);

/** v0 manifest, trimmed from the reference repo's own `sagan.yaml`. */
const MANIFEST = `pm:\n  state: ledger\nproviders:\n  claude: { containment: prompt-gated }\nbindings:\n  frontend: { provider: claude }\n`;

/** A repo root that is a Sagan project, optionally carrying a ledger. Returns
 *  the root and a nested folder inside it (the sidebar can hold either). */
function saganRepo(name: string, ledger?: string): { root: string; nested: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `conan-sagan-api-${name}-`));
  const root = path.join(base, "repo");
  const nested = path.join(root, "packages", "api");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, ".sagan"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sagan", "sagan.yaml"), MANIFEST);
  if (ledger !== undefined) {
    fs.mkdirSync(path.join(root, ".sagan", "ledger"), { recursive: true });
    fs.writeFileSync(saganLedgerPath(root), ledger);
  }
  return { root, nested };
}

/** Adopt a folder as a Conan project and resolve it the way the routes do. */
function projectFor(dir: string) {
  const row = upsertChatProject(dir);
  const project = resolveSaganProject(row.id);
  assert.ok(project, `no project resolved for ${dir}`);
  return project;
}

test("AC1: lists every ticket in the project's ledger, most recent first", () => {
  const { root } = saganRepo("list", REFERENCE);
  const result = listSaganRuns(projectFor(root));

  assert.deepEqual(
    result.runs.map((r) => r.id),
    ["WHA-130", "WHA-131", "T-001"],
    "ordering is the last ledger LINE per ticket — `ts` is day-granular and cannot order",
  );
  assert.equal(result.ledgerPath, saganLedgerPath(root));
  assert.equal(result.project?.root, root);
  assert.equal(result.project?.sagan.state, "valid");
  // The run id IS the ticket id — no Linear title fetch (non-goal).
  for (const run of result.runs) assert.equal(run.id, run.ticket);
});

test("AC1: a summary carries what Overview draws a row from", () => {
  const { root } = saganRepo("summary", REFERENCE);
  const runs = listSaganRuns(projectFor(root)).runs;
  const wha130 = runs.find((r) => r.id === "WHA-130");
  assert.ok(wha130);
  assert.equal(wha130.lane, "critique");
  assert.equal(wha130.phase, "dispatched");
  assert.equal(wha130.round, 3);
  assert.equal(wha130.verdict, "APPROVED");
  assert.deepEqual(wha130.agent, { name: "critic-claude-fresh", role: "critic" });
  assert.equal(wha130.firstTs, "2026-08-06");
  assert.equal(wha130.lastTs, "2026-08-06");
  assert.equal(wha130.laneCount, 4);
  assert.equal(wha130.verdictCount, 3);
  assert.equal(wha130.evidenceCount, 3);

  const t001 = runs.find((r) => r.id === "T-001");
  // The last lane names a verifier, not a builder — the role is read off the
  // key the ledger used, never inferred from the lane name.
  assert.deepEqual(t001?.agent, { name: "verify-claude", role: "verifier" });
});

test("GOLDEN: needsYou is the reopened gate, not the answered one", () => {
  const { root } = saganRepo("needsyou", REFERENCE);
  const runs = listSaganRuns(projectFor(root)).runs;
  assert.deepEqual(
    runs.filter((r) => r.needsYou).map((r) => r.id),
    ["WHA-130"],
    "needed → made(revise) → needed(round 3) is still open; T-001 and WHA-131 are answered",
  );
  const wha130 = runs.find((r) => r.id === "WHA-130")!;
  assert.equal(wha130.openDecisions.length, 1);
  assert.equal(wha130.openDecisions[0]!.gate, "promote");
  assert.equal(wha130.openDecisions[0]!.round, 3);
  assert.equal(wha130.openDecisions[0]!.evidenceSha, "9be4459");
});

test("AC2: the detail keeps every lane, phase and verdict in file order", () => {
  const { root } = saganRepo("detail", REFERENCE);
  const result = getSaganRun(projectFor(root), "WHA-130");
  assert.ok(result);
  const run = result.run;

  assert.deepEqual(
    run.lanes.map((l) => [l.lane, l.phase]),
    [
      ["frontend", "dispatched"],
      ["frontend", "built"],
      ["frontend", "revised"],
      ["critique", "dispatched"],
    ],
  );
  assert.deepEqual(run.lanes[1]!.artifact, "site/");
  assert.deepEqual(run.lanes[1]!.flags, ["engraving-inner-scroll-375"]);
  // `artifact_sha` and `sha` are the same fact under two names.
  assert.equal(run.lanes[2]!.sha, "fee9144");

  assert.deepEqual(
    run.verdicts.map((v) => [v.round, v.verdict]),
    [[1, "REVISE"], [2, "APPROVED"], [3, "APPROVED"]],
    "the projection keeps only the last verdict; the inspector needs all three",
  );
  assert.equal(run.verdicts[0]!.findings, 6, "findings is a COUNT on critique.verdict");
  assert.equal(run.verdicts[0]!.high, 2);
  assert.equal(run.verdicts[1]!.blocking, 0);
  assert.equal(run.verdicts[2]!.artifactSha, "9be4459");

  // Entries are ledger line numbers, so the surface can interleave the lists.
  assert.ok(run.lanes.every((l, i) => i === 0 || l.index > run.lanes[i - 1]!.index));
});

test("AC2: evidence refs keep both recorded shapes whole", () => {
  const { root } = saganRepo("evidence", REFERENCE);
  const wha130 = getSaganRun(projectFor(root), "WHA-130")!.run;

  const [produced, first, delta] = wha130.evidence;
  // Producer shape: artifacts as a STRING in the real file.
  assert.equal(produced!.producer, "pm-render");
  assert.deepEqual(produced!.artifacts, [
    ".sagan/refs/wha-130-renders/ (375+1280 x light+dark full-page)",
  ]);
  assert.equal(produced!.note, "round-1 predictable evidence");
  // Verifier shape: sha + counted checks + the honest not-verified list.
  assert.equal(first!.verifier, "verify-claude");
  assert.equal(first!.sha, "1aca52d");
  assert.equal(first!.overall, "PASS");
  assert.equal(first!.checks, 3);
  assert.equal(first!.notVerified.length, 2);
  assert.equal(delta!.deltaOf, "1aca52d");

  // …and the array form on WHA-131, which the string branch must not mangle.
  const wha131 = getSaganRun(projectFor(root), "WHA-131")!.run;
  assert.equal(wha131.evidence[0]!.artifacts.length, 2);
  assert.equal(wha131.evidence[0]!.note, "AC5 grid-overlay + ink-alignment judgment");
  assert.equal(wha131.verdicts[0]!.evidenceNeeded, "grid-overlay-on renders");
});

test("AC2: decision history says WHY the run is on round 3", () => {
  const { root } = saganRepo("decisions", REFERENCE);
  const run = getSaganRun(projectFor(root), "WHA-130")!.run;
  assert.deepEqual(
    run.decisionHistory.map((d) => [d.kind, d.decision]),
    [["needed", null], ["made", "revise"], ["needed", null]],
  );
  const revise = run.decisionHistory[1]!;
  assert.deepEqual(revise.findings, ["reads-as-slides-not-website", "no-navigation"]);
  assert.equal(revise.amendment, "AC2 continuous document + sticky mono index");
  assert.equal(revise.by, "randy");
  // The superseded answer is history, not the gate's state.
  assert.equal(run.resolvedDecisions.length, 0);
  assert.equal(run.needsYou, true);
});

test("AC5: history is every ledger line for the ticket, verbatim", () => {
  const { root } = saganRepo("history", REFERENCE);
  const run = getSaganRun(projectFor(root), "T-001")!.run;
  assert.deepEqual(
    run.history.map((h) => h.event),
    [
      "lane.updated",
      "lane.updated",
      "critique.verdict",
      "lane.updated",
      "evidence.recorded",
      "critique.verdict",
      "decision.needed",
      "decision.made",
    ],
  );
  assert.equal(run.history.length, run.eventCount);
  // Verbatim: keys this build has no field for still reach the inspector.
  assert.deepEqual(run.history[0]!.data.pack, ["/abs/agent-fleet", "tickets/T-001.md"]);
  // …and no other ticket's lines leak into it.
  assert.ok(run.history.every((h) => h.data.ticket === "T-001"));
});

test("WHA-143: detail normalizes inspector context and current timestamps", () => {
  const { root } = saganRepo("inspector", lines(
    { event: "lane.updated", ticket: "WHA-143", lane: "frontend", phase: "dispatched",
      builder: "Booker", attempt_id: "attempt-7", session_id: "session-42",
      timestamp: "2026-08-08T15:07:46Z" },
    { event: "evidence.recorded", ticket: "WHA-143", artifacts: ["evidence/inspector.png"],
      output: "Inspector verified", timestamp: "2026-08-08T16:00:00Z" },
  ));
  fs.mkdirSync(path.join(root, ".sagan", "tickets"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".sagan", "tickets", "WHA-143.md"),
    "# WHA-143 — C3: Inspector from ledger timeline\n",
  );

  const run = getSaganRun(projectFor(root), "WHA-143")!.run;
  assert.equal(run.context.objective, "C3: Inspector from ledger timeline");
  assert.equal(run.context.provider, "claude");
  assert.equal(run.context.containment, "prompt-gated");
  assert.equal(run.context.attemptId, "attempt-7");
  assert.deepEqual(run.context.owningTarget, { kind: "session", id: "session-42" });
  assert.equal(run.firstTs, "2026-08-08T15:07:46Z");
  assert.equal(run.lastTs, "2026-08-08T16:00:00Z");
  assert.equal(run.history[0]!.ts, "2026-08-08T15:07:46Z");
});

test("WHA-143: owning target stays absent when the ledger has no real id", () => {
  const { root } = saganRepo("no-owner", lines(
    { event: "lane.updated", ticket: "WHA-143", lane: "frontend", phase: "building",
      builder: "Booker", timestamp: "2026-08-08T15:07:46Z" },
  ));
  assert.equal(getSaganRun(projectFor(root), "WHA-143")!.run.context.owningTarget, null);
});

test("AC4: an unknown ticket id is 404 material, not a throw", () => {
  const { root } = saganRepo("unknown-ticket", REFERENCE);
  assert.equal(getSaganRun(projectFor(root), "WHA-999"), null);
  assert.equal(getSaganRun(projectFor(root), ""), null);
});

test("AC3: a ticket id shaped like a path is a miss, never a read", () => {
  const { root } = saganRepo("traversal", REFERENCE);
  const project = projectFor(root);
  for (const id of [
    "../../etc/passwd",
    "..",
    "/etc/passwd",
    "WHA-130/../T-001",
  ]) {
    assert.equal(getSaganRun(project, id), null, `${id} must not resolve`);
  }
  // The id only ever meets strings read out of the file.
  assert.equal(getSaganRun(project, "WHA-130")?.run.id, "WHA-130");
});

test("AC3: one project never sees another project's ledger", () => {
  const a = saganRepo("scope-a", REFERENCE);
  const b = saganRepo(
    "scope-b",
    lines({
      event: "lane.updated", ticket: "OTHER-1", lane: "frontend", phase: "built",
      ts: "2026-08-07",
    }),
  );
  const projectA = projectFor(a.root);
  const projectB = projectFor(b.root);

  assert.notEqual(projectA.id, projectB.id);
  assert.deepEqual(listSaganRuns(projectB).runs.map((r) => r.id), ["OTHER-1"]);
  assert.equal(
    listSaganRuns(projectA).runs.some((r) => r.id === "OTHER-1"),
    false,
  );
  // B's ticket is unreachable through A's id, and vice versa.
  assert.equal(getSaganRun(projectA, "OTHER-1"), null);
  assert.equal(getSaganRun(projectB, "WHA-130"), null);
});

test("AC4: an unknown project id resolves to null — never a fallback project", () => {
  const { root } = saganRepo("fallback", REFERENCE);
  projectFor(root); // a real project exists; the bad id must still miss
  assert.equal(resolveSaganProject("not-a-project-id"), null);
  assert.equal(resolveSaganProject(""), null);
});

test("a nested project folder reads the repo root's ledger", () => {
  const { root, nested } = saganRepo("nested", REFERENCE);
  const project = projectFor(nested);
  assert.equal(project.path, nested);
  assert.equal(project.root, root, "the ledger lives at the repo root, not the cwd");
  assert.equal(listSaganRuns(project).runs.length, 3);
});

test("AC4: a Sagan project with no ledger yet is an empty list, not an error", () => {
  const { root } = saganRepo("no-ledger");
  const result = listSaganRuns(projectFor(root));
  assert.deepEqual(result.runs, []);
  assert.equal(result.project?.sagan.state, "valid");
  assert.deepEqual(result.skipped, { unparseable: 0, unknownType: 0, noTicket: 0 });
});

test("AC4: a non-Sagan project answers empty plus the reason", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "conan-sagan-api-plain-"));
  fs.mkdirSync(path.join(base, ".git"), { recursive: true });
  const result = listSaganRuns(projectFor(base));
  assert.deepEqual(result.runs, []);
  assert.equal(result.project?.sagan.state, "absent");
});

test("a half-written ledger still lists, with the damage counted", () => {
  const { root } = saganRepo("torn", REFERENCE + '{"event":"lane.updated","tick');
  const result = listSaganRuns(projectFor(root));
  assert.equal(result.runs.length, 3, "a torn final line must not blank the surface");
  assert.equal(result.skipped.unparseable, 1);
});

test("an event type this build has never seen is counted, not fatal", () => {
  const { root } = saganRepo(
    "future",
    REFERENCE +
      lines({ event: "gate.escalated", ticket: "WHA-130", to: "randy", ts: "2026-08-07" }),
  );
  const result = listSaganRuns(projectFor(root));
  assert.equal(result.skipped.unknownType, 1);
  assert.equal(result.runs.length, 3);
  // …and the inspector still shows the line, because history drops nothing.
  const run = getSaganRun(projectFor(root), "WHA-130")!.run;
  assert.equal(run.history.at(-1)!.event, "gate.escalated");
});

// ─── projectId as a PATH ────────────────────────────────────────────────────
// The id may also be an absolute path on disk. It buys the same one folder and
// nothing more, so every test below is really asking the same question: does
// this string get to name a folder the routes will read?

test("a projectId that is an absolute repo path lists that repo's runs", () => {
  const { root } = saganRepo("path-root", REFERENCE);
  const project = resolveSaganProject(root);
  assert.ok(project);
  assert.equal(project.source, "path");
  assert.equal(project.root, root);
  assert.equal(project.path, root);
  assert.deepEqual(
    listSaganRuns(project).runs.map((r) => r.id),
    ["WHA-130", "WHA-131", "T-001"],
  );
  // …and the detail route reaches the same ledger through the same id.
  assert.equal(getSaganRun(project, "WHA-130")?.run.round, 3);
});

test("a path inside the repo resolves to the repo root's ledger", () => {
  const { root, nested } = saganRepo("path-nested", REFERENCE);
  const project = resolveSaganProject(nested);
  assert.ok(project);
  assert.equal(project.path, nested);
  assert.equal(project.root, root, "the ledger lives at the repo root, not the cwd");
  assert.equal(listSaganRuns(project).runs.length, 3);
});

test("a path with `..` segments is judged as the folder it actually names", () => {
  const { root, nested } = saganRepo("path-dotdot", REFERENCE);
  // `repo/packages/api/../..` IS the root — normalised, then accepted on its
  // own merits, not refused for its shape.
  const project = resolveSaganProject(path.join(nested, "..", ".."));
  assert.equal(project?.root, root);

  // …and one that climbs OUT of every repo has no root to scope to.
  assert.equal(resolveSaganProject(path.join(root, "..", "..", "..", "..", "..")), null);
});

test("a path that is not a project is a miss, not a read", () => {
  const { root } = saganRepo("path-reject", REFERENCE);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "conan-sagan-api-outside-"));
  fs.writeFileSync(path.join(outside, "secrets.txt"), "nope");

  for (const [id, why] of [
    ["", "empty"],
    ["   ", "blank"],
    ["relative/path", "relative — would resolve against the gateway's own cwd"],
    ["../../etc", "relative traversal"],
    [path.join(root, "does-not-exist"), "no such directory"],
    [saganLedgerPath(root), "a file, not a directory"],
    [outside, "a real directory, but inside no git repo"],
    ["/", "the filesystem root is inside no repo"],
  ] as const) {
    assert.equal(resolveSaganProject(id), null, `${JSON.stringify(id)} must miss: ${why}`);
  }
});

test("AC4: an id that resolves to nothing is an empty list, never a throw", () => {
  const result = listSaganRuns(resolveSaganProject("/no/such/project"));
  assert.deepEqual(result.runs, []);
  assert.equal(result.project, null);
  assert.equal(result.ledgerPath, null);
  assert.ok(result.reason, "the empty list says why");
  assert.deepEqual(result.skipped, { unparseable: 0, unknownType: 0, noTicket: 0 });
});

test("AC3: two repo paths never see each other's runs", () => {
  const a = saganRepo("path-scope-a", REFERENCE);
  const b = saganRepo(
    "path-scope-b",
    lines({
      event: "lane.updated", ticket: "OTHER-1", lane: "frontend", phase: "built",
      ts: "2026-08-07",
    }),
  );
  const projectA = resolveSaganProject(a.root)!;
  const projectB = resolveSaganProject(b.root)!;
  assert.deepEqual(listSaganRuns(projectB).runs.map((r) => r.id), ["OTHER-1"]);
  assert.equal(listSaganRuns(projectA).runs.some((r) => r.id === "OTHER-1"), false);
  assert.equal(getSaganRun(projectA, "OTHER-1"), null);
});

test("AC3: a ledger symlinked out of the root is refused, not followed", () => {
  const inside = saganRepo("symlink-inside", REFERENCE);
  const { root } = saganRepo("symlink-host");
  // The composed path is textually contained — `root/.sagan/ledger/…` — but
  // `.sagan/ledger` points at another project's ledger directory. Containment
  // of the STRING is not containment of the FILE.
  fs.symlinkSync(
    path.join(inside.root, ".sagan", "ledger"),
    path.join(root, ".sagan", "ledger"),
  );
  assert.ok(fs.existsSync(saganLedgerPath(root)), "the symlink does resolve to a real file");

  const project = resolveSaganProject(root)!;
  const result = listSaganRuns(project);
  assert.deepEqual(result.runs, [], "nothing outside the root is read");
  assert.equal(result.ledgerOutsideRoot, true, "…and the empty list says so");
  assert.equal(getSaganRun(project, "WHA-130"), null);
});

test("ledgerWithinRoot: a real in-root ledger reads, a missing one is fine", () => {
  const withLedger = saganRepo("within-yes", REFERENCE);
  assert.equal(ledgerWithinRoot(withLedger.root), true);
  const noLedger = saganRepo("within-none");
  assert.equal(
    ledgerWithinRoot(noLedger.root),
    true,
    "a project that has never run reads nothing, so nothing escapes",
  );
  assert.equal(ledgerWithinRoot(path.join(noLedger.root, "no-such-root")), false);
});

test("a project row id still resolves, and reports which door it came through", () => {
  const { root } = saganRepo("row-still-works", REFERENCE);
  const byRow = projectFor(root);
  assert.equal(byRow.source, "project-row");
  const byPath = resolveSaganProject(root)!;
  assert.equal(byPath.source, "path");
  // Different ids, same folder, same runs — the id is a door, not a scope.
  assert.notEqual(byRow.id, byPath.id);
  assert.deepEqual(
    listSaganRuns(byRow).runs.map((r) => r.id),
    listSaganRuns(byPath).runs.map((r) => r.id),
  );
});

// C5 — append decision.made for human gates.
const OPEN_LEDGER = lines(
  { event: "lane.updated", ticket: "WHA-145", lane: "frontend", phase: "built", ts: "2026-08-09" },
  { event: "critique.verdict", ticket: "WHA-145", round: 1, critic: "critic-claude-fresh", verdict: "APPROVED", ts: "2026-08-09" },
  { event: "decision.needed", ticket: "WHA-145", gate: "promote", state: "awaiting-randy", round: 1, evidence_sha: "abc123", ts: "2026-08-09" },
);

test("WHA-145: appendDecisionMade writes an approve decision to an open gate", async () => {
  const { root } = saganRepo("append-approve", OPEN_LEDGER);
  const { appendDecisionMade, readLedger } = await import("./ledger.js");
  const result = appendDecisionMade(saganLedgerPath(root), {
    ticket: "WHA-145",
    gate: "promote",
    decision: "approve",
    by: "randy",
    round: null,
  });
  assert.equal(result.event.decision, "approve");
  assert.equal(result.event.by, "randy");
  assert.equal(result.event.round, 1, "round is copied from the open decision.needed");
  assert.ok(result.event.timestamp);
  const projection = readLedger(saganLedgerPath(root));
  const ticket = projection.tickets.find((t) => t.ticket === "WHA-145");
  assert.equal(ticket?.openDecisions.length, 0, "gate is now closed");
  assert.equal(ticket?.resolvedDecisions[0]?.decision, "approve");
});

test("WHA-145: appendDecisionMade writes a revise decision with findings and amendment", async () => {
  const { root } = saganRepo("append-revise", OPEN_LEDGER);
  const { appendDecisionMade, readLedger } = await import("./ledger.js");
  appendDecisionMade(saganLedgerPath(root), {
    ticket: "WHA-145",
    gate: "promote",
    decision: "revise",
    by: "randy",
    round: null,
    findings: ["missing tests", "needs UI polish"],
    amendment: "Add UI tests before re-critique",
  });
  const projection = readLedger(saganLedgerPath(root));
  const history = projection.tickets.find((t) => t.ticket === "WHA-145")?.decisionHistory;
  const revise = history?.find((d) => d.kind === "made");
  assert.ok(revise);
  assert.deepEqual(revise?.findings, ["missing tests", "needs UI polish"]);
  assert.equal(revise?.amendment, "Add UI tests before re-critique");
  // A revise decision is recorded as a resolved decision; the gate is no longer
  // open until a later round posts a fresh decision.needed (the WHA-130 ledger
  // does exactly that: round 2 revise, then a round 3 decision.needed).
  const ticket = projection.tickets.find((t) => t.ticket === "WHA-145");
  assert.equal(ticket?.openDecisions.length, 0);
  assert.equal(ticket?.resolvedDecisions.length, 1);
  assert.equal(ticket?.resolvedDecisions[0]?.decision, "revise");
});

test("WHA-145: appendDecisionMade refuses to write to a closed gate", async () => {
  const { root } = saganRepo("append-closed", OPEN_LEDGER);
  const { appendDecisionMade } = await import("./ledger.js");
  appendDecisionMade(saganLedgerPath(root), {
    ticket: "WHA-145",
    gate: "promote",
    decision: "approve",
    by: "randy",
    round: null,
  });
  assert.throws(
    () => appendDecisionMade(saganLedgerPath(root), {
      ticket: "WHA-145",
      gate: "promote",
      decision: "approve",
      by: "randy",
      round: null,
    }),
    /no open decision\.needed event/,
  );
});
