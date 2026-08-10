// WHA-125 AC 6: the dry-run, under test rather than as a one-off script.
//
// The Method block is explicit that this is the phase's real proof — the first
// time the whole journey exists as data instead of prose. So the assertions are
// about ROWS: what landed in which table, with which columns populated, and
// what the trust hooks were handed before a process would have started.
//
// Runs against a throwaway SQLite file — env is pointed at a temp dir BEFORE
// the db module (which captures paths at import) is loaded, same idiom as
// src/fleet/dispatch.test.ts. Zero model calls, zero processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-dryrun-test-"));
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = path.join(dataDir, "conan.db");

const { getDb } = await import("../db/index.js");
const { runLineageDryRun } = await import("./dryrun.js");
const { ticketIdForLinearKey } = await import("./lineage.js");

const result = await runLineageDryRun({ linearKey: "WHA-125-DRYRUN" });

function row(sql: string, ...params: unknown[]): Record<string, unknown> {
  const r = getDb().prepare(sql).get(...params) as
    | Record<string, unknown>
    | undefined;
  assert.ok(r, `no row for: ${sql}`);
  return r;
}

function all(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

test("AC 5: the ticket is keyed internally, with linear_key alongside", () => {
  const t = row("SELECT * FROM fleet_ticket WHERE ticket_id = ?", result.ticketId);
  assert.equal(t.linear_key, "WHA-125-DRYRUN");
  assert.notEqual(
    t.ticket_id,
    t.linear_key,
    "the internal id must not BE the Linear key — that is the whole point of AC 5",
  );
  // The external key resolves to the internal one without a credential.
  assert.equal(ticketIdForLinearKey("WHA-125-DRYRUN"), result.ticketId);
});

test("AC 1: the build attempt carries containment, cost and duration as columns", () => {
  const a = row("SELECT * FROM attempt WHERE id = ?", result.buildAttemptId);
  assert.equal(a.context, "fleet-attempt");
  assert.equal(a.containment_observed, "os-sandbox");
  assert.equal(a.cost_usd, 0.42);
  assert.equal(typeof a.duration_ms, "number");
  assert.ok(typeof a.ended_at === "number", "a disposed attempt must be closed");
});

test("the fleet attempt is attributed to its run, ticket, task, role and identity", () => {
  const a = row("SELECT * FROM attempt WHERE id = ?", result.buildAttemptId);
  assert.equal(a.run_id, result.runId);
  assert.equal(a.ticket_id, result.ticketId);
  assert.equal(a.task_id, result.taskId);
  assert.equal(a.role, "backend");
  assert.equal(a.principal_id, "dryrun-nash");
  assert.equal(a.binding_id, "dryrun-nash-binding");
});

test("the attempt↔session bridge keeps every session id, not just the last", () => {
  // `--resume` forks the provider session id mid-attempt. The column holds the
  // current name; the bridge is what lets a lookup by the OLD id still land.
  const bound = all(
    "SELECT session_id FROM attempt_session WHERE attempt_id = ? ORDER BY session_id",
    result.buildAttemptId,
  ).map((r) => r.session_id);
  assert.deepEqual(bound, ["dryrun-session-1", "dryrun-session-1-resumed"]);
  const a = row("SELECT session_id FROM attempt WHERE id = ?", result.buildAttemptId);
  assert.equal(a.session_id, "dryrun-session-1-resumed", "the column tracks the latest");
});

test("AC 3: the evidence row carries every freeze §5 column, with its commands", () => {
  const e = row("SELECT * FROM fleet_evidence WHERE evidence_id = ?", result.evidenceId);
  for (const col of [
    "evidence_id",
    "sha",
    "attempt_id",
    "runner_principal_id",
    "runner_binding_id",
    "harness",
    "observation_method",
    "recorded_at",
  ]) {
    assert.ok(e[col] != null, `evidence.${col} is null`);
  }
  assert.equal(e.attempt_id, result.verifyAttemptId);
  assert.equal(e.runner_principal_id, "dryrun-barkley");
  assert.equal(e.harness, "npm test");
  assert.equal(e.observation_method, "exit-code");

  const commands = all(
    "SELECT * FROM fleet_evidence_command WHERE evidence_id = ? ORDER BY seq",
    result.evidenceId,
  );
  assert.equal(commands.length, 2);
  assert.deepEqual(
    commands.map((c) => [c.seq, c.cmd, c.exit_code]),
    [
      [0, "npm run typecheck", 0],
      [1, "npm test", 0],
    ],
  );
});

test("AC 6: the journey exists as rows — NEEDS_EVIDENCE then a fresh APPROVED", () => {
  const first = row(
    "SELECT * FROM fleet_critique WHERE critique_id = ?",
    result.needsEvidenceCritiqueId,
  );
  assert.equal(first.verdict, "NEEDS_EVIDENCE");
  assert.equal(first.round, 1);
  assert.equal(first.evidence_id, null, "NEEDS_EVIDENCE binds nothing yet");
  assert.equal(first.critic_attempt_id, result.firstCritiqueAttemptId);
  assert.notEqual(
    first.critic_attempt_id,
    result.buildAttemptId,
    "the builder graded its own work",
  );

  const approved = row(
    "SELECT * FROM fleet_critique WHERE critique_id = ?",
    result.approvedCritiqueId,
  );
  assert.equal(approved.verdict, "APPROVED");
  assert.equal(approved.round, 2);
  // Freeze §4: the critic is a fresh attempt, not the one that produced the
  // evidence and not the builder's.
  assert.equal(approved.critic_attempt_id, result.criticAttemptId);
  assert.notEqual(approved.critic_attempt_id, approved.evidence_attempt_id);
  assert.notEqual(approved.critic_attempt_id, result.buildAttemptId);

  const decision = row(
    "SELECT * FROM fleet_decision WHERE decision_id = ?",
    result.promoteDecisionId,
  );
  assert.equal(decision.gate, "promote");
  assert.equal(decision.decision, "promote");
  assert.equal(decision.critique_id, result.approvedCritiqueId);
});

test("AC 4: the verdict binds the evidence PRODUCER, digest, rubric and model", () => {
  const c = row(
    "SELECT * FROM fleet_critique WHERE critique_id = ?",
    result.approvedCritiqueId,
  );
  assert.equal(c.evidence_id, result.evidenceId);
  assert.equal(c.evidence_sha, "0".repeat(40));
  assert.equal(c.evidence_attempt_id, result.verifyAttemptId);
  // The producer, which is the field AC 4 adds on top of the freeze doc's list.
  assert.equal(c.evidence_principal_id, "dryrun-barkley");
  assert.equal(c.evidence_binding_id, "dryrun-barkley-binding");
  assert.equal(c.rubric_version, "sagan-roles@0.1.0");
  assert.equal(c.critic_model, "stub-critic");
});

test("AC 6: dispatch is refused on self-verify, before anything spawns", () => {
  const leg = result.refusals.find((r) => r.leg === "self-verify");
  assert.ok(leg, "no self-verify leg in the dry-run");
  assert.equal(leg.refusal.code, "self-verify");
  assert.equal(leg.spawned, false, "a refused dispatch wrote an attempt row");

  // What the hook was HANDED is the assertion that matters: the verdict itself
  // is stubbed here and belongs to WHA-126.
  const call = result.hookCalls.find(
    (c) => c.hook === "checkIdentity" && c.request.round === 3,
  );
  assert.ok(call, "checkIdentity was never called");
  assert.equal(call.request.candidate.principalId, "dryrun-nash");
  assert.equal(
    call.request.builder?.principalId,
    "dryrun-nash",
    "the predicate must see the builder it is being compared against",
  );
  assert.equal(call.request.role, "verify");
  assert.equal(call.request.taskId, result.taskId);
  assert.equal(call.request.ticketId, result.ticketId);
});

test("AC 6: dispatch is refused on floor violation, with the RESOLVED class", () => {
  const leg = result.refusals.find((r) => r.leg === "floor-violation");
  assert.ok(leg, "no floor-violation leg in the dry-run");
  assert.equal(leg.refusal.code, "floor-violation");
  assert.equal(leg.spawned, false);

  const call = result.hookCalls.find((c) => c.hook === "checkFloor");
  assert.ok(call, "checkFloor was never called");
  // The class is the one resolveContainment() derived from (claude, default) —
  // not a value the caller passed in, which is what makes the check meaningful.
  assert.equal(call.request.containment, "prompt-gated");
  assert.deepEqual([...call.request.floor], ["os-sandbox"]);
});

test("a refusal is recorded as a decision, with a machine-readable code", () => {
  const refusals = all(
    "SELECT * FROM fleet_decision WHERE run_id = ? AND gate = 'dispatch' ORDER BY created_at",
    result.runId,
  );
  assert.equal(refusals.length, 2);
  assert.deepEqual(
    refusals.map((r) => [r.state, r.decision, r.reason_code]),
    [
      ["made", "refuse", "self-verify"],
      ["made", "refuse", "floor-violation"],
    ],
  );
  for (const r of refusals) {
    assert.ok(r.reason, "a refusal with no human-readable reason is unreadable");
  }
});

test("the dry-run prints a transcript a human can check", () => {
  assert.ok(result.log.length >= 8, "the dry-run log is too thin to be evidence");
  const joined = result.log.join("\n");
  for (const needle of ["NEEDS_EVIDENCE", "APPROVED", "self-verify", "floor-violation"]) {
    assert.ok(joined.includes(needle), `the log never mentions ${needle}`);
  }
});
