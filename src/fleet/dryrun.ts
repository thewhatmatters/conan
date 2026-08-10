// WHA-125 AC 6: the lineage dry-run.
//
// The whole journey as DATA rather than prose:
//
//   ticket → run → task → role assignments → build attempt → artifact
//     → NEEDS_EVIDENCE → evidence (+ commands) → FRESH critic attempt
//     → APPROVED → promote decision
//
// plus the two refusal legs: a dispatch refused on self-verify and one refused
// on floor violation, each recorded as a `fleet_decision` row.
//
// ⚠ WHAT THIS DOES AND DOES NOT PROVE. The refusal legs prove the PLUMBING:
// that the dispatcher calls the trust predicates before it spawns anything,
// with the resolved containment class and the role's declared floor, and that a
// refusal produces no process, no attempt row, and a recorded decision. The
// predicates used here are STUBS that refuse unconditionally — they do not
// compare the candidate to the builder or the class to the floor, because those
// verdicts are WHA-126's and implementing them here would fork the rule. Read a
// green refusal leg as "the hook was called with the right arguments", never as
// "self-verify is enforced".
//
// No process is ever spawned: the provider fixtures below hand back a no-op
// driver. That is what makes this runnable in CI and in a test.
import type { AgentDriver, AgentEvent } from "../agent/driver.js";
import type { ProviderEntry } from "../agent/registry.js";
import { getDb } from "../db/index.js";
import {
  DispatchRefused,
  type FleetDispatchRequest,
  type Refusal,
  type RefusalCode,
  type TrustPredicates,
} from "./admission.js";
import { createDispatcher } from "./dispatch.js";
import {
  assignRole,
  recordArtifact,
  recordBinding,
  recordCritique,
  recordDecision,
  recordEvidence,
  recordPrincipal,
  recordRun,
  recordTask,
  recordTicket,
  setTaskState,
  type Identity,
} from "./lineage.js";

/** One call into a trust predicate, captured with the exact request it saw.
 *  This is the artifact AC 6's refusal half is actually asserted against. */
/** The registry's provider id union — `resolveContainment` keys on it. */
type ProviderId = AgentDriver["provider"];

export interface DryRunHookCall {
  hook: "checkIdentity" | "checkFloor";
  request: FleetDispatchRequest;
}

export interface DryRunRefusal {
  leg: "self-verify" | "floor-violation";
  refusal: Refusal;
  /** The request the predicate was handed — resolved containment and all. */
  request: FleetDispatchRequest;
  /** True when no attempt row was written for the refused dispatch. */
  spawned: boolean;
}

export interface DryRunResult {
  ticketId: string;
  linearKey: string;
  runId: string;
  taskId: string;
  buildAttemptId: string;
  verifyAttemptId: string;
  criticAttemptId: string;
  /** The critic attempt that recorded round 1's NEEDS_EVIDENCE. */
  firstCritiqueAttemptId: string;
  artifactId: string;
  needsEvidenceCritiqueId: string;
  evidenceId: string;
  approvedCritiqueId: string;
  promoteDecisionId: string;
  refusals: DryRunRefusal[];
  hookCalls: DryRunHookCall[];
  /** Human-readable transcript; the script prints this. */
  log: string[];
}

/** A provider entry that builds a driver which does nothing. A dry run must not
 *  start a process; everything else on the path is the real code. The id is a
 *  REAL provider id on purpose — `resolveContainment` keys on it, so the class
 *  recorded here is the one the resolver would give a real spawn. */
function fixtureProvider(id: ProviderId): ProviderEntry {
  const driver: AgentDriver = {
    provider: id,
    capabilities: {} as AgentDriver["capabilities"],
    send: async () => {},
    interrupt: () => {},
    respondPermission: () => {},
    setPermissionMode: () => {},
    dispose: () => {},
  };
  return { id, createDriver: () => driver } as unknown as ProviderEntry;
}

/** A stub that refuses from ONE hook, unconditionally. It inspects nothing —
 *  see the warning at the top of this file. */
function stubRefusingFrom(
  hook: "checkIdentity" | "checkFloor",
  code: RefusalCode,
  message: string,
): TrustPredicates {
  const refuse = (): Refusal => ({ code, message });
  return {
    checkIdentity: hook === "checkIdentity" ? refuse : () => null,
    checkFloor: hook === "checkFloor" ? refuse : () => null,
  };
}

/** Wrap predicates so every call and its arguments are captured. */
function recording(
  inner: TrustPredicates,
  sink: DryRunHookCall[],
): TrustPredicates {
  return {
    checkIdentity: (request) => {
      sink.push({ hook: "checkIdentity", request });
      return inner.checkIdentity(request);
    },
    checkFloor: (request) => {
      sink.push({ hook: "checkFloor", request });
      return inner.checkFloor(request);
    },
  };
}

const CRITIC_FLOOR = ["os-sandbox"] as const;
const LANE = "correctness";
const RUBRIC_VERSION = "sagan-roles@0.1.0";

/**
 * Run the whole lineage journey against the current database.
 *
 * The caller owns which database that is (`CONAN_DATA_DIR`) — there is one
 * persistence path and this does not open a second one. Every write throws on
 * failure: a dry-run that half-worked and reported success would be worse than
 * no dry-run.
 */
export async function runLineageDryRun(
  opts: { linearKey?: string; cwd?: string | null } = {},
): Promise<DryRunResult> {
  const log: string[] = [];
  const hookCalls: DryRunHookCall[] = [];
  const say = (line: string): void => {
    log.push(line);
  };
  const cwd = opts.cwd ?? null;
  const linearKey = opts.linearKey ?? `DRY-${Date.now()}`;

  // ── the cast ───────────────────────────────────────────────────────────────
  const builder = registerAgent("nash", "Nash (build)", "codex", "read-only");
  const verifier = registerAgent(
    "barkley",
    "Barkley (verify)",
    "codex",
    "read-only",
  );
  const critic = registerAgent("booker", "Booker (critic)", "codex", "read-only");
  say(
    `principals: builder=${builder.principalId} verifier=${verifier.principalId} critic=${critic.principalId}`,
  );

  // ── ticket → run → task → roles ────────────────────────────────────────────
  const ticketId = recordTicket({
    linearKey,
    title: "Fleet lineage dry-run",
  });
  const runId = recordRun({ ticketId, lane: LANE });
  const taskId = recordTask({ runId, title: "Ship the lineage schema" });
  assignRole({ taskId, role: "backend", identity: builder });
  assignRole({
    taskId,
    role: "verify",
    identity: verifier,
    containmentFloor: CRITIC_FLOOR,
  });
  assignRole({
    taskId,
    role: "critic",
    identity: critic,
    containmentFloor: CRITIC_FLOOR,
  });
  say(`ticket ${ticketId} (linear_key ${linearKey}) → run ${runId} → task ${taskId}`);
  say(`roles assigned: backend, verify, critic (floor ${CRITIC_FLOOR.join("|")})`);

  // ── build attempt ──────────────────────────────────────────────────────────
  const build = await dispatch({
    role: "backend",
    identity: builder,
    builder: null,
    providerId: "codex",
    permissionMode: "default",
    runId,
    ticketId,
    taskId,
    round: 1,
    cwd,
  });
  setTaskState(taskId, "dispatched");
  // AC 1's columns, populated the way a real turn populates them.
  build.dispatcher.bindSession("dryrun-session-1");
  build.dispatcher.bindSession("dryrun-session-1-resumed"); // --resume forks the id
  build.dispatcher.recordCost(0.42);
  build.dispatcher.dispose();
  say(`build attempt ${build.attemptId} (containment ${build.containment}), cost + duration stamped`);

  // ── artifact at an exact sha ───────────────────────────────────────────────
  const sha = "0".repeat(40);
  const artifactId = recordArtifact({
    taskId,
    attemptId: build.attemptId,
    artifactClass: "executable",
    path: "src/db/schema.sql",
    sha,
  });
  say(`artifact ${artifactId} @ ${sha.slice(0, 7)} (executable → evidence required)`);

  // ── round 1: NEEDS_EVIDENCE, bound to nothing ──────────────────────────────
  // On its own critic attempt, not the builder's. Freeze §4 wants the critic
  // fresh for the APPROVED transition; letting the builder's attempt sign the
  // round-1 verdict would model a self-assessment the loop does not do.
  const firstCritique = await dispatch({
    role: "critic",
    identity: critic,
    builder,
    providerId: "codex",
    permissionMode: "default",
    runId,
    ticketId,
    taskId,
    round: 1,
    cwd,
  });
  const needsEvidenceCritiqueId = recordCritique({
    taskId,
    artifactId,
    lane: LANE,
    round: 1,
    verdict: "NEEDS_EVIDENCE",
    rubricVersion: RUBRIC_VERSION,
    criticModel: "stub-critic",
    criticAttemptId: firstCritique.attemptId,
  });
  firstCritique.dispatcher.dispose();
  say(
    `critique ${needsEvidenceCritiqueId} round 1 → NEEDS_EVIDENCE ` +
      `(critic attempt ${firstCritique.attemptId}, binds nothing)`,
  );

  // ── evidence, produced by the verifier's own attempt ────────────────────────
  const verify = await dispatch({
    role: "verify",
    identity: verifier,
    builder,
    providerId: "codex",
    permissionMode: "default",
    runId,
    ticketId,
    taskId,
    round: 2,
    cwd,
  });
  const evidenceId = recordEvidence({
    artifactId,
    sha,
    attemptId: verify.attemptId,
    runner: verifier,
    harness: "npm test",
    observationMethod: "exit-code",
    commands: [
      { cmd: "npm run typecheck", cwd: ".", exitCode: 0, durationMs: 4200 },
      { cmd: "npm test", cwd: ".", exitCode: 0, durationMs: 18000 },
    ],
  });
  verify.dispatcher.dispose();
  say(`evidence ${evidenceId} by ${verifier.principalId} on attempt ${verify.attemptId} (2 commands)`);

  // ── round 2: a FRESH critic attempt, binding the evidence ──────────────────
  const critique = await dispatch({
    role: "critic",
    identity: critic,
    builder,
    providerId: "codex",
    permissionMode: "default",
    runId,
    ticketId,
    taskId,
    round: 2,
    cwd,
  });
  const approvedCritiqueId = recordCritique({
    taskId,
    artifactId,
    lane: LANE,
    round: 2,
    verdict: "APPROVED",
    bind: {
      evidenceId,
      sha,
      attemptId: verify.attemptId,
      producer: verifier,
    },
    rubricVersion: RUBRIC_VERSION,
    criticModel: "stub-critic",
    criticAttemptId: critique.attemptId,
  });
  critique.dispatcher.dispose();
  say(
    `critique ${approvedCritiqueId} round 2 → APPROVED, bound to evidence ${evidenceId} ` +
      `+ producer ${verifier.principalId}/${verifier.bindingId} + rubric ${RUBRIC_VERSION}`,
  );

  // ── the gate ───────────────────────────────────────────────────────────────
  const promoteDecisionId = recordDecision({
    runId,
    taskId,
    gate: "promote",
    state: "made",
    decision: "promote",
    critiqueId: approvedCritiqueId,
    decidedByPrincipalId: critic.principalId,
  });
  setTaskState(taskId, "done");
  say(`decision ${promoteDecisionId} gate=promote → promote`);

  // ── refusal legs ───────────────────────────────────────────────────────────
  const refusals: DryRunRefusal[] = [
    await refuse({
      leg: "self-verify",
      hook: "checkIdentity",
      code: "self-verify",
      message: "stub: the verifier may not be the builder",
      // The candidate IS the builder — the arguments a real checkIdentity
      // compares. The stub does not compare them; WHA-126 will.
      role: "verify",
      identity: builder,
      builderIdentity: builder,
      providerId: "codex",
      permissionMode: "default",
      runId,
      ticketId,
      taskId,
      round: 3,
      cwd,
      hookCalls,
      say,
    }),
    await refuse({
      leg: "floor-violation",
      hook: "checkFloor",
      code: "floor-violation",
      message: "stub: prompt-gated is not in the critic's allowed set",
      // claude + default resolves to `prompt-gated`, against a floor of
      // {os-sandbox}. Again: the stub refuses without comparing.
      role: "critic",
      identity: critic,
      builderIdentity: builder,
      providerId: "claude",
      permissionMode: "default",
      runId,
      ticketId,
      taskId,
      round: 3,
      cwd,
      hookCalls,
      say,
    }),
  ];

  return {
    ticketId,
    linearKey,
    runId,
    taskId,
    buildAttemptId: build.attemptId,
    verifyAttemptId: verify.attemptId,
    criticAttemptId: critique.attemptId,
    firstCritiqueAttemptId: firstCritique.attemptId,
    artifactId,
    needsEvidenceCritiqueId,
    evidenceId,
    approvedCritiqueId,
    promoteDecisionId,
    refusals,
    hookCalls,
    log,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function registerAgent(
  id: string,
  displayName: string,
  provider: string,
  permissionMode: string,
): Identity {
  const principalId = recordPrincipal({
    principalId: `dryrun-${id}`,
    kind: "agent",
    displayName,
  });
  const bindingId = recordBinding({
    bindingId: `dryrun-${id}-binding`,
    principalId,
    provider,
    permissionMode,
  });
  return { principalId, bindingId };
}

interface DispatchArgs {
  role: string;
  identity: Identity;
  builder: Identity | null;
  providerId: ProviderId;
  permissionMode: string;
  runId: string;
  ticketId: string;
  taskId: string;
  round: number;
  cwd: string | null;
  predicates?: TrustPredicates;
}

/** Dispatch through the REAL seam (src/fleet/dispatch.ts) with a no-op driver,
 *  so the attempt row, its lineage columns and its containment class are
 *  produced by production code rather than by this file. */
async function dispatch(args: DispatchArgs): Promise<{
  dispatcher: ReturnType<typeof createDispatcher>;
  attemptId: string;
  containment: string;
}> {
  const dispatcher = createDispatcher({
    context: "fleet-attempt",
    emit: (_e: AgentEvent) => {},
    fallbackCwd: () => args.cwd,
    fleet: {
      request: {
        runId: args.runId,
        ticketId: args.ticketId,
        taskId: args.taskId,
        role: args.role,
        candidate: args.identity,
        builder: args.builder,
        floor: args.role === "backend" ? [] : CRITIC_FLOOR,
        round: args.round,
      },
      predicates: args.predicates,
    },
  });
  const spawned = await dispatcher.spawn(async () => ({
    provider: fixtureProvider(args.providerId),
    model: null,
    permissionMode: args.permissionMode,
    cwd: args.cwd,
  }));
  if (!spawned.attemptId) {
    throw new Error(`dry-run dispatch produced no attempt row for ${args.role}`);
  }
  return {
    dispatcher,
    attemptId: spawned.attemptId,
    containment: spawned.containment,
  };
}

interface RefuseArgs extends Omit<DispatchArgs, "predicates" | "builder"> {
  leg: "self-verify" | "floor-violation";
  hook: "checkIdentity" | "checkFloor";
  code: RefusalCode;
  message: string;
  builderIdentity: Identity;
  hookCalls: DryRunHookCall[];
  say: (line: string) => void;
}

async function refuse(args: RefuseArgs): Promise<DryRunRefusal> {
  const before = args.hookCalls.length;
  const predicates = recording(
    stubRefusingFrom(args.hook, args.code, args.message),
    args.hookCalls,
  );
  const attemptsBefore = attemptCount();
  let refusal: Refusal | null = null;
  try {
    await dispatch({ ...args, builder: args.builderIdentity, predicates });
  } catch (err) {
    if (!(err instanceof DispatchRefused)) throw err;
    refusal = err.refusal;
  }
  // Measured, not asserted: a refusal that still wrote an attempt row would
  // mean the check ran too late to be enforcement.
  const spawned = attemptCount() > attemptsBefore;
  if (!refusal) {
    throw new Error(`dry-run: ${args.leg} dispatch was NOT refused`);
  }
  const call = args.hookCalls.slice(before).find((c) => c.hook === args.hook);
  if (!call) throw new Error(`dry-run: ${args.hook} was never called`);
  args.say(
    `refused ${args.leg}: ${args.hook} saw candidate=${call.request.candidate.principalId} ` +
      `builder=${call.request.builder?.principalId ?? "none"} ` +
      `containment=${call.request.containment} floor=[${call.request.floor.join("|")}] ` +
      `→ ${refusal.code}; attempt row written: ${spawned ? "YES (bug)" : "no"}`,
  );
  return { leg: args.leg, refusal, request: call.request, spawned };
}

/** How many attempt rows exist right now — the refusal legs' "did anything
 *  spawn" measurement. */
function attemptCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM attempt").get() as {
    n: number;
  };
  return row.n;
}
