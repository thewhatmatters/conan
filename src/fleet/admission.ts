// WHA-125 (fleet phase 1b): the dispatch admission seam.
//
// ⚠ THE VERDICTS ARE NOT IMPLEMENTED HERE, ON PURPOSE. `checkIdentity` and
// `checkFloor` are WHA-126's trust predicates. This ticket ships the SEAM they
// plug into and the plumbing that turns a refusal into a refused dispatch and a
// recorded decision row — the shipped default admits everything, which is
// exactly what the dispatcher does today, so nothing silently changes
// behaviour. AC 6's dry-run proves the hook is called with the right arguments;
// what the hook then decides is the next ticket's.
//
// Why the seam is worth shipping a phase early: a predicate is only enforcement
// if every spawn passes through it. Retrofitting the call site later means
// auditing every dispatch path again, and freeze §1.1 exists precisely to avoid
// that. The hole is left in the right place now, with a test standing in it.
import type { ContainmentClass } from "./containment.js";
import type { Identity } from "./lineage.js";

/** Refusal reasons the fleet knows how to record. Open to WHA-126 adding more;
 *  `fleet_decision.reason_code` is deliberately unconstrained text so a new
 *  code does not need a migration. */
export type RefusalCode =
  | "self-verify"
  | "floor-violation"
  | "round-cap"
  | "ac-missing";

/** A refusal is part of the contract, not an exception case: a machine-readable
 *  code for the ledger and a human message for whoever is reading the run. */
export interface Refusal {
  code: RefusalCode;
  message: string;
}

/** Everything a trust predicate is entitled to see. Assembled by the dispatcher
 *  so no caller can hand a predicate a flattering version of the facts —
 *  `containment` in particular is the class RESOLVED at spawn from (provider,
 *  permission_mode), never a value the caller supplied. */
export interface FleetDispatchRequest {
  runId: string;
  /** Internal ticket id (AC 5), never the Linear key — freeze §9's "AC exists
   *  before dispatch" predicate resolves the ticket through this. */
  ticketId: string;
  taskId: string;
  /** The role being dispatched — `.sagan/roles/<role>.md`. */
  role: string;
  /** Who is about to run. */
  candidate: Identity;
  /** The identity being checked against: the builder whose work a critic or
   *  verifier is about to judge. Null when there is nothing to be independent
   *  of (the build dispatch itself). */
  builder: Identity | null;
  /** Resolved at spawn from (provider, permission_mode) — freeze §2. */
  containment: ContainmentClass;
  /** The role's allowed-set. Empty means no floor was declared. */
  floor: readonly ContainmentClass[];
  /** Which critique round this dispatch belongs to; 1 for the first build. */
  round: number;
}

/** The two predicates AC 6 refuses on. Freeze §9 lists two more (AC exists,
 *  round caps) that belong to the same seam — they join this interface in
 *  WHA-126 rather than being guessed at here. */
export interface TrustPredicates {
  /** Freeze §3: same instance/principal as the builder is refused. */
  checkIdentity(request: FleetDispatchRequest): Refusal | null;
  /** Freeze §2: the resolved class must be in the role's allowed set. */
  checkFloor(request: FleetDispatchRequest): Refusal | null;
}

/**
 * The shipped default: admits everything.
 *
 * This is a STUB, and it is honest about it — returning `null` means "no
 * refusal", which is the behaviour Conan has today with no predicates at all.
 * WHA-126 replaces this object; nothing else on the path has to change.
 */
export const stubTrustPredicates: TrustPredicates = {
  checkIdentity: () => null,
  checkFloor: () => null,
};

/** Thrown by the dispatcher when admission refuses. Carries the refusal so the
 *  caller can render the code, not just a string it has to parse back. */
export class DispatchRefused extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(`dispatch refused (${refusal.code}): ${refusal.message}`);
    this.name = "DispatchRefused";
    this.refusal = refusal;
  }
}

/**
 * Run the predicates against a dispatch request; the first refusal wins.
 *
 * Order is fixed — identity, then floor — so two runs of the same bad request
 * produce the same reason code. A refusal that varies by evaluation order is
 * unreadable in a ledger.
 */
export function admitFleetDispatch(
  request: FleetDispatchRequest,
  predicates: TrustPredicates = stubTrustPredicates,
): Refusal | null {
  return (
    predicates.checkIdentity(request) ?? predicates.checkFloor(request) ?? null
  );
}
