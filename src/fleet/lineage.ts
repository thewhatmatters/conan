// WHA-125 (fleet phase 1b): row IO for the lineage tables.
//
// Sibling of attempts.ts, with one deliberate difference: EVERY WRITE HERE
// THROWS. attempts.ts swallows failures because a chat turn dying to record its
// own metadata is worse than lineage with a hole in it — the user is mid-
// conversation and owns the session. A fleet run is the opposite: the ledger IS
// the deliverable. A promote gate that clears because a critique row silently
// failed to write is the exact failure mode this phase exists to prevent, so a
// broken write stops the run and says so.
//
// Contract: docs/conan-fleet-phase0-freeze.md. Every table's reasoning lives in
// src/db/schema.sql next to the DDL; this file only names the seam.
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { CONTAINMENT_CLASSES, type ContainmentClass } from "./containment.js";

/** Freeze §4's verdict vocabulary, mirrored from `.sagan/sagan.yaml`
 *  (`critique.verdict`) and constrained by a CHECK on fleet_critique. */
export type Verdict = "NEEDS_EVIDENCE" | "APPROVED" | "REVISE" | "ESCALATE";

/** Freeze §4: what it takes to reach APPROVED. A doc can be accepted on read;
 *  anything executable needs evidence; anything a human sees may need an eye
 *  (§6.3). Stored, not inferred from a file extension. */
export type ArtifactClass = "read-verifiable" | "executable" | "user-visible";

/** Freeze §5: how the observation was made. */
export type ObservationMethod =
  | "exit-code"
  | "screenshot"
  | "capture"
  | "human-read"
  | "log-read";

/** Freeze §3: identity is the pair, never the provider or the model alone. */
export interface Identity {
  principalId: string;
  bindingId: string;
}

const now = (): number => Date.now();

// ─── who ─────────────────────────────────────────────────────────────────────

export interface PrincipalInput {
  principalId?: string;
  kind: "agent" | "human";
  displayName: string;
}

/** Insert a principal, or leave an existing one untouched. Idempotent on
 *  `principal_id` so a run that re-registers its cast is not an error. */
export function recordPrincipal(input: PrincipalInput): string {
  const id = input.principalId ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO fleet_principal (principal_id, kind, display_name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (principal_id) DO NOTHING`,
    )
    .run(id, input.kind, input.displayName, now());
  return id;
}

export interface BindingInput {
  bindingId?: string;
  principalId: string;
  provider: string;
  model?: string | null;
  permissionMode?: string | null;
  /** The class this binding is PINNED to, when it is pinned at all. Null means
   *  "resolved at spawn" — the attempt row is the authoritative record. */
  containment?: ContainmentClass | null;
}

export function recordBinding(input: BindingInput): string {
  const id = input.bindingId ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO fleet_binding
         (binding_id, principal_id, provider, model, permission_mode,
          containment_observed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (binding_id) DO NOTHING`,
    )
    .run(
      id,
      input.principalId,
      input.provider,
      input.model ?? null,
      input.permissionMode ?? null,
      input.containment ?? null,
      now(),
    );
  return id;
}

// ─── what ────────────────────────────────────────────────────────────────────

export interface TicketInput {
  /** AC 5: the internal key. Generated when the caller has none — a ticket
   *  exists before anyone has mirrored it anywhere. */
  ticketId?: string;
  /** AC 5: the external id (`WHA-125`), or null. Unique when present. */
  linearKey?: string | null;
  title: string;
}

export function recordTicket(input: TicketInput): string {
  const id = input.ticketId ?? randomUUID();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO fleet_ticket
         (ticket_id, linear_key, title, state, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?)
       ON CONFLICT (ticket_id) DO NOTHING`,
    )
    .run(id, input.linearKey ?? null, input.title, ts, ts);
  return id;
}

/** AC 5's other half: resolve an external key to the internal id without the
 *  caller having to know whether the ticket was mirrored. Null when unknown. */
export function ticketIdForLinearKey(linearKey: string): string | null {
  const row = getDb()
    .prepare("SELECT ticket_id FROM fleet_ticket WHERE linear_key = ?")
    .get(linearKey) as { ticket_id: string } | undefined;
  return row?.ticket_id ?? null;
}

export interface RunInput {
  runId?: string;
  ticketId: string;
  /** `.sagan/sagan.yaml` owns the lane vocabulary; this column does not. */
  lane: string;
}

export function recordRun(input: RunInput): string {
  const id = input.runId ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO fleet_run (run_id, ticket_id, lane, state, started_at)
       VALUES (?, ?, ?, 'running', ?)
       ON CONFLICT (run_id) DO NOTHING`,
    )
    .run(id, input.ticketId, input.lane, now());
  return id;
}

export function closeRun(
  runId: string,
  state: "complete" | "escalated" | "abandoned",
): void {
  getDb()
    .prepare(
      "UPDATE fleet_run SET state = ?, ended_at = ? WHERE run_id = ? AND ended_at IS NULL",
    )
    .run(state, now(), runId);
}

export interface TaskInput {
  taskId?: string;
  runId: string;
  title: string;
}

export function recordTask(input: TaskInput): string {
  const id = input.taskId ?? randomUUID();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO fleet_task (task_id, run_id, title, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (task_id) DO NOTHING`,
    )
    .run(id, input.runId, input.title, ts, ts);
  return id;
}

export function setTaskState(
  taskId: string,
  state: "pending" | "dispatched" | "done" | "abandoned",
): void {
  getDb()
    .prepare("UPDATE fleet_task SET state = ?, updated_at = ? WHERE task_id = ?")
    .run(state, now(), taskId);
}

export interface RoleAssignmentInput {
  assignmentId?: string;
  taskId: string;
  /** Matches a file in `.sagan/roles/` — backend, critic, verify, … */
  role: string;
  identity: Identity;
  /** Freeze §2: an explicit ALLOWED SET, not a threshold. Empty/omitted means
   *  no floor is declared for this role. */
  containmentFloor?: readonly ContainmentClass[] | null;
}

export function assignRole(input: RoleAssignmentInput): string {
  const id = input.assignmentId ?? randomUUID();
  const floor = input.containmentFloor ?? null;
  // Validate at the boundary: the column is JSON text and the database can only
  // check that it parses. A typo'd class inside a well-formed array would read
  // as an unsatisfiable floor and refuse every dispatch for reasons nobody
  // could see, so it is rejected here, where the caller still has a stack.
  if (floor) {
    for (const c of floor) {
      if (!CONTAINMENT_CLASSES.includes(c)) {
        throw new TypeError(`unknown containment class in floor: ${String(c)}`);
      }
    }
  }
  getDb()
    .prepare(
      `INSERT INTO fleet_role_assignment
         (assignment_id, task_id, role, principal_id, binding_id,
          containment_floor, assigned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, role) DO UPDATE SET
         principal_id      = excluded.principal_id,
         binding_id        = excluded.binding_id,
         containment_floor = excluded.containment_floor,
         assigned_at       = excluded.assigned_at`,
    )
    .run(
      id,
      input.taskId,
      input.role,
      input.identity.principalId,
      input.identity.bindingId,
      floor ? JSON.stringify(floor) : null,
      now(),
    );
  return id;
}

/** The identity currently assigned to a role on a task, or null. This is the
 *  read WHA-126's `checkIdentity` needs to answer "is the candidate the
 *  builder?" — the predicate is its own ticket, the lookup is this one's. */
export function assignedIdentity(taskId: string, role: string): Identity | null {
  const row = getDb()
    .prepare(
      "SELECT principal_id, binding_id FROM fleet_role_assignment WHERE task_id = ? AND role = ?",
    )
    .get(taskId, role) as
    | { principal_id: string; binding_id: string }
    | undefined;
  return row
    ? { principalId: row.principal_id, bindingId: row.binding_id }
    : null;
}

/** The declared allowed-set for a role, or null when none was declared. */
export function containmentFloorFor(
  taskId: string,
  role: string,
): ContainmentClass[] | null {
  const row = getDb()
    .prepare(
      "SELECT containment_floor FROM fleet_role_assignment WHERE task_id = ? AND role = ?",
    )
    .get(taskId, role) as { containment_floor: string | null } | undefined;
  if (!row?.containment_floor) return null;
  const parsed: unknown = JSON.parse(row.containment_floor);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((c): c is ContainmentClass =>
    (CONTAINMENT_CLASSES as readonly string[]).includes(c as string),
  );
}

// ─── artifacts, evidence, verdicts ───────────────────────────────────────────

export interface ArtifactInput {
  artifactId?: string;
  taskId: string;
  attemptId?: string | null;
  artifactClass: ArtifactClass;
  path?: string | null;
  /** Git sha or content digest — the exact state everything downstream binds. */
  sha: string;
}

export function recordArtifact(input: ArtifactInput): string {
  const id = input.artifactId ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO fleet_artifact
         (artifact_id, task_id, attempt_id, artifact_class, path, sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.taskId,
      input.attemptId ?? null,
      input.artifactClass,
      input.path ?? null,
      input.sha,
      now(),
    );
  return id;
}

/** Freeze §5's `commands[]` entry. */
export interface EvidenceCommand {
  cmd: string;
  cwd?: string | null;
  exitCode?: number | null;
  stdoutDigest?: string | null;
  durationMs?: number | null;
}

export interface EvidenceInput {
  evidenceId?: string;
  artifactId: string;
  /** The state the evidence was taken against. Copied, not joined: §6.1's
   *  stale-tip rule needs both the then and the now. */
  sha: string;
  attemptId: string;
  runner: Identity;
  harness: string;
  observationMethod: ObservationMethod;
  commands?: readonly EvidenceCommand[];
}

/** AC 3. Written in ONE transaction with its commands: evidence that claims a
 *  test run but lost the command rows would read as an unsupported PASS, which
 *  is worse than no evidence at all. */
export function recordEvidence(input: EvidenceInput): string {
  const id = input.evidenceId ?? randomUUID();
  const db = getDb();
  const insertEvidence = db.prepare(
    `INSERT INTO fleet_evidence
       (evidence_id, artifact_id, sha, attempt_id, runner_principal_id,
        runner_binding_id, harness, observation_method, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCommand = db.prepare(
    `INSERT INTO fleet_evidence_command
       (evidence_id, seq, cmd, cwd, exit_code, stdout_digest, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    insertEvidence.run(
      id,
      input.artifactId,
      input.sha,
      input.attemptId,
      input.runner.principalId,
      input.runner.bindingId,
      input.harness,
      input.observationMethod,
      now(),
    );
    (input.commands ?? []).forEach((c, seq) => {
      insertCommand.run(
        id,
        seq,
        c.cmd,
        c.cwd ?? null,
        c.exitCode ?? null,
        c.stdoutDigest ?? null,
        c.durationMs ?? null,
      );
    });
  })();
  return id;
}

/** AC 4: what a verdict is bound to. The producer identity travels WITH the
 *  evidence id rather than being looked up later, because a bind is a snapshot:
 *  what was approved must not change when the evidence row does. */
export interface EvidenceBind {
  evidenceId: string;
  sha: string;
  attemptId: string;
  producer: Identity;
}

export interface CritiqueInput {
  critiqueId?: string;
  taskId: string;
  artifactId: string;
  lane: string;
  round: number;
  verdict: Verdict;
  findings?: number;
  /** Required for APPROVED (a CHECK enforces it); omitted for NEEDS_EVIDENCE. */
  bind?: EvidenceBind | null;
  rubricVersion: string;
  criticModel: string;
  /** The attempt the critic ran as. Freeze §4 wants it fresh: the database
   *  refuses it being the evidence producer's attempt. */
  criticAttemptId: string;
}

export function recordCritique(input: CritiqueInput): string {
  const id = input.critiqueId ?? randomUUID();
  const bind = input.bind ?? null;
  getDb()
    .prepare(
      `INSERT INTO fleet_critique
         (critique_id, task_id, artifact_id, lane, round, verdict, findings,
          evidence_id, evidence_sha, evidence_attempt_id, evidence_principal_id,
          evidence_binding_id, rubric_version, critic_model, critic_attempt_id,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.taskId,
      input.artifactId,
      input.lane,
      input.round,
      input.verdict,
      input.findings ?? 0,
      bind?.evidenceId ?? null,
      bind?.sha ?? null,
      bind?.attemptId ?? null,
      bind?.producer.principalId ?? null,
      bind?.producer.bindingId ?? null,
      input.rubricVersion,
      input.criticModel,
      input.criticAttemptId,
      now(),
    );
  return id;
}

export interface DecisionInput {
  decisionId?: string;
  runId: string;
  taskId?: string | null;
  /** `dispatch`, `promote`, … — the ledger's gate vocabulary, an open set. */
  gate: string;
  state: "needed" | "made";
  decision?: "approve" | "revise" | "promote" | "escalate" | "refuse" | null;
  /** Machine-readable half; mandatory for a refusal (enforced by a CHECK). */
  reasonCode?: string | null;
  reason?: string | null;
  critiqueId?: string | null;
  attemptId?: string | null;
  decidedByPrincipalId?: string | null;
}

export function recordDecision(input: DecisionInput): string {
  const id = input.decisionId ?? randomUUID();
  getDb()
    .prepare(
      `INSERT INTO fleet_decision
         (decision_id, run_id, task_id, gate, state, decision, reason_code,
          reason, critique_id, attempt_id, decided_by_principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.runId,
      input.taskId ?? null,
      input.gate,
      input.state,
      input.decision ?? null,
      input.reasonCode ?? null,
      input.reason ?? null,
      input.critiqueId ?? null,
      input.attemptId ?? null,
      input.decidedByPrincipalId ?? null,
      now(),
    );
  return id;
}
