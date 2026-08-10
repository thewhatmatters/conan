// WHA-125: the constraints, not the happy path.
//
// The dry-run (dryrun.test.ts) proves the journey can be written. This file
// proves the states that MUST NOT be writable are not writable — at the
// database, where a future caller written by someone who never read this ticket
// still hits them. Every failing case below is a rule from
// docs/conan-fleet-phase0-freeze.md that would otherwise live in a comment.
//
// Throwaway SQLite file; env pointed at a temp dir before the db module loads.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conan-lineage-test-"));
process.env.CONAN_DATA_DIR = dataDir;
process.env.CONAN_DB_PATH = path.join(dataDir, "conan.db");

const { getDb } = await import("../db/index.js");
const {
  assignRole,
  containmentFloorFor,
  assignedIdentity,
  recordArtifact,
  recordBinding,
  recordCritique,
  recordDecision,
  recordEvidence,
  recordPrincipal,
  recordRun,
  recordTask,
  recordTicket,
} = await import("./lineage.js");
const { openAttempt } = await import("./attempts.js");

// ─── a minimal cast, reused by every case ────────────────────────────────────
const builderPrincipal = recordPrincipal({
  kind: "agent",
  displayName: "builder",
});
const builderBinding = recordBinding({
  principalId: builderPrincipal,
  provider: "codex",
  containment: "os-sandbox",
});
const builder = { principalId: builderPrincipal, bindingId: builderBinding };
const ticketId = recordTicket({ linearKey: "WHA-000", title: "constraints" });
const runId = recordRun({ ticketId, lane: "correctness" });
const taskId = recordTask({ runId, title: "constraints" });

function newAttempt(): string {
  const id = openAttempt({
    context: "fleet-attempt",
    provider: "codex",
    model: null,
    permissionMode: "read-only",
    containment: "os-sandbox",
    cwd: null,
    lineage: { runId, ticketId, taskId, role: "backend", identity: builder },
  });
  assert.ok(id, "attempt insert failed");
  return id as string;
}

function newArtifact(sha = "a".repeat(40)): string {
  return recordArtifact({
    taskId,
    artifactClass: "executable",
    sha,
  });
}

test("AC 2: a chat attempt cannot carry lineage", () => {
  const id = openAttempt({
    context: "chat",
    provider: "claude",
    model: null,
    permissionMode: "default",
    containment: "prompt-gated",
    cwd: null,
  });
  const row = getDb()
    .prepare("SELECT * FROM attempt WHERE id = ?")
    .get(id) as Record<string, unknown>;
  for (const col of [
    "run_id",
    "ticket_id",
    "task_id",
    "role",
    "principal_id",
    "binding_id",
  ]) {
    assert.equal(row[col], null, `chat attempt leaked lineage in ${col}`);
  }
});

test("AC 5: linear_key is unique when present and optional when absent", () => {
  // Two tickets with no external key at all — the Linear story is off the
  // critical path, so this has to be legal.
  recordTicket({ title: "no key A" });
  recordTicket({ title: "no key B" });
  assert.throws(
    () => recordTicket({ linearKey: "WHA-000", title: "duplicate" }),
    /UNIQUE/,
    "two tickets claimed the same Linear key",
  );
});

test("freeze §4: APPROVED cannot be recorded without bound evidence", () => {
  const artifactId = newArtifact("b".repeat(40));
  assert.throws(
    () =>
      recordCritique({
        taskId,
        artifactId,
        lane: "correctness",
        round: 1,
        verdict: "APPROVED",
        rubricVersion: "r1",
        criticModel: "m",
        criticAttemptId: newAttempt(),
      }),
    /CHECK constraint failed/,
    "approve-by-side-effect is still representable",
  );
  // REVISE with no evidence is legitimate and must stay legal — a critic can
  // send work back before anything has been run.
  const id = recordCritique({
    taskId,
    artifactId,
    lane: "correctness",
    round: 1,
    verdict: "REVISE",
    findings: 3,
    rubricVersion: "r1",
    criticModel: "m",
    criticAttemptId: newAttempt(),
  });
  assert.ok(id);
});

test("freeze §4: the critic's attempt cannot be the evidence producer's", () => {
  const artifactId = newArtifact("c".repeat(40));
  const producerAttempt = newAttempt();
  const evidenceId = recordEvidence({
    artifactId,
    sha: "c".repeat(40),
    attemptId: producerAttempt,
    runner: builder,
    harness: "npm test",
    observationMethod: "exit-code",
    commands: [{ cmd: "npm test", exitCode: 0 }],
  });
  assert.throws(
    () =>
      recordCritique({
        taskId,
        artifactId,
        lane: "correctness",
        round: 1,
        verdict: "APPROVED",
        bind: {
          evidenceId,
          sha: "c".repeat(40),
          attemptId: producerAttempt,
          producer: builder,
        },
        rubricVersion: "r1",
        criticModel: "m",
        // The same attempt that produced the evidence is grading it.
        criticAttemptId: producerAttempt,
      }),
    /CHECK constraint failed/,
  );
});

test("one verdict per artifact per lane per round", () => {
  const artifactId = newArtifact("d".repeat(40));
  const write = (): string =>
    recordCritique({
      taskId,
      artifactId,
      lane: "correctness",
      round: 2,
      verdict: "REVISE",
      rubricVersion: "r1",
      criticModel: "m",
      criticAttemptId: newAttempt(),
    });
  write();
  assert.throws(write, /UNIQUE/, "a round can be graded twice");
});

test("evidence cannot name an attempt that does not exist", () => {
  const artifactId = newArtifact("e".repeat(40));
  assert.throws(
    () =>
      recordEvidence({
        artifactId,
        sha: "e".repeat(40),
        attemptId: "no-such-attempt",
        runner: builder,
        harness: "npm test",
        observationMethod: "exit-code",
      }),
    /FOREIGN KEY constraint failed/,
    "foreign keys are off, or evidence can float free of its producer",
  );
});

test("evidence commands are written in the same transaction as the evidence", () => {
  const artifactId = newArtifact("f".repeat(40));
  const before = (
    getDb().prepare("SELECT COUNT(*) AS n FROM fleet_evidence").get() as {
      n: number;
    }
  ).n;
  assert.throws(() =>
    recordEvidence({
      artifactId,
      sha: "f".repeat(40),
      attemptId: newAttempt(),
      runner: builder,
      harness: "npm test",
      observationMethod: "exit-code",
      // An empty command string violates the CHECK — the evidence row must roll
      // back with it, or the ledger keeps a PASS with no commands behind it.
      commands: [{ cmd: "", exitCode: 0 }],
    }),
  );
  const after = (
    getDb().prepare("SELECT COUNT(*) AS n FROM fleet_evidence").get() as {
      n: number;
    }
  ).n;
  assert.equal(after, before, "a half-written evidence row survived");
});

test("a refusal must carry a machine-readable code", () => {
  assert.throws(
    () =>
      recordDecision({
        runId,
        taskId,
        gate: "dispatch",
        state: "made",
        decision: "refuse",
        reason: "because",
      }),
    /CHECK constraint failed/,
  );
  // And a gate that is merely OPEN needs no decision at all.
  assert.ok(
    recordDecision({ runId, taskId, gate: "promote", state: "needed" }),
  );
});

test("freeze §2: a containment floor is a validated allowed-SET", () => {
  assignRole({
    taskId,
    role: "critic",
    identity: builder,
    containmentFloor: ["os-sandbox", "fail-closed-cancel"],
  });
  assert.deepEqual(containmentFloorFor(taskId, "critic"), [
    "os-sandbox",
    "fail-closed-cancel",
  ]);
  assert.deepEqual(assignedIdentity(taskId, "critic"), builder);
  assert.equal(containmentFloorFor(taskId, "backend"), null);

  assert.throws(
    () =>
      assignRole({
        taskId,
        role: "verify",
        identity: builder,
        // A typo'd class inside well-formed JSON would read as an
        // unsatisfiable floor and refuse every dispatch invisibly.
        containmentFloor: ["os-sandboxx" as never],
      }),
    /unknown containment class/,
  );
});

test("re-assigning a role replaces the holder rather than duplicating it", () => {
  const second = recordPrincipal({ kind: "human", displayName: "randy" });
  const secondBinding = recordBinding({
    principalId: second,
    provider: "claude",
  });
  assignRole({
    taskId,
    role: "critic",
    identity: { principalId: second, bindingId: secondBinding },
  });
  const rows = getDb()
    .prepare("SELECT * FROM fleet_role_assignment WHERE task_id = ? AND role = 'critic'")
    .all(taskId);
  assert.equal(rows.length, 1, "a task grew two critics");
  assert.deepEqual(assignedIdentity(taskId, "critic"), {
    principalId: second,
    bindingId: secondBinding,
  });
});

test("lineage rows refuse to be deleted out from under their evidence", () => {
  const artifactId = newArtifact("9".repeat(40));
  const attemptId = newAttempt();
  recordEvidence({
    artifactId,
    sha: "9".repeat(40),
    attemptId,
    runner: builder,
    harness: "npm test",
    observationMethod: "exit-code",
  });
  // RESTRICT, not CASCADE: an audit ledger surfaces the attempted delete rather
  // than quietly erasing who produced the evidence.
  assert.throws(
    () => getDb().prepare("DELETE FROM attempt WHERE id = ?").run(attemptId),
    /FOREIGN KEY constraint failed/,
  );
});
