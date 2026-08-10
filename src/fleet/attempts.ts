// WHA-129 (fleet phase 1a): row IO for the `attempt` table.
//
// One row per agent process actually spawned. Every write here is best-effort:
// a DB failure must never break a chat turn, exactly like the chat_thread
// persistence in src/agent/index.ts. Lineage that costs the user their session
// is worse than lineage with a hole in it.
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import type { ContainmentClass } from "./containment.js";
import type { Identity } from "./lineage.js";
import { resolveProjectId } from "./project.js";

/** Freeze doc §1.2: one seam, two policies. `chat` skips the fleet predicates
 *  (an interactive turn has no ticket, AC, verifier pair, or round counter);
 *  `fleet-attempt` is a task attempt under lineage and runs all of them. */
export type DispatchContext = "chat" | "fleet-attempt";

/** WHA-125: what ties an attempt to a run. Present only for `fleet-attempt`. */
export interface AttemptLineage {
  runId: string;
  ticketId: string;
  taskId: string;
  /** `.sagan/roles/<role>.md` — which station this attempt is serving. */
  role: string;
  /** Freeze §3: who ran it, as the pair. */
  identity: Identity;
}

interface AttemptOpenBase {
  provider: string;
  model: string | null;
  permissionMode: string | null;
  containment: ContainmentClass;
  cwd: string | null;
}

/** AC 2 as a type, not a comment: a `chat` attempt CANNOT carry lineage. The
 *  union makes `{ context: "chat", lineage: … }` a compile error rather than a
 *  row that claims a ticket nobody dispatched. */
export type AttemptOpen =
  | (AttemptOpenBase & { context: "chat"; lineage?: never })
  | (AttemptOpenBase & {
      context: "fleet-attempt";
      lineage?: AttemptLineage | null;
    });

/** Insert an attempt row for a spawn that just happened. Returns the new id,
 *  or null if the write failed (the caller keeps running without lineage). */
export function openAttempt(open: AttemptOpen): string | null {
  const id = randomUUID();
  try {
    // WHA-136: resolved here rather than passed in, so every caller of the seam
    // gets the same answer and no spawn path can forget to anchor its attempt.
    const projectId = resolveProjectId(open.cwd);
    // AC 2: a chat attempt writes six nulls. Belt to the type's braces — a
    // JavaScript caller has no compiler to stop it, and a lineage column set on
    // a `chat` row would make the ledger claim a run that never happened.
    const lineage = open.context === "fleet-attempt" ? (open.lineage ?? null) : null;
    getDb()
      .prepare(
        `INSERT INTO attempt
           (id, context, session_id, provider, model, permission_mode,
            containment_observed, cwd, project_id, started_at,
            run_id, ticket_id, task_id, role, principal_id, binding_id)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        open.context,
        open.provider,
        open.model,
        open.permissionMode,
        open.containment,
        open.cwd,
        projectId,
        Date.now(),
        lineage?.runId ?? null,
        lineage?.ticketId ?? null,
        lineage?.taskId ?? null,
        lineage?.role ?? null,
        lineage?.identity.principalId ?? null,
        lineage?.identity.bindingId ?? null,
      );
    return id;
  } catch (err) {
    console.warn(`[fleet] attempt open failed: ${(err as Error).message}`);
    return null;
  }
}

/** Backfill the provider's session id once it reports one at init. A process
 *  is spawned before it has a name, so this cannot be done at insert time.
 *
 *  WHA-125: the id is ALSO appended to the `attempt_session` bridge. The column
 *  is overwritten on every rebind and `--resume` forks into a fresh session id
 *  mid-attempt, so the column alone answers "what is it called now" and forgets
 *  what it was called when the earlier turns were recorded. Both writes ride
 *  one transaction — a bridge row for a session the attempt does not admit to,
 *  or the reverse, is a worse ledger than either alone. */
export function bindAttemptSession(attemptId: string, sessionId: string): void {
  try {
    const db = getDb();
    const setCurrent = db.prepare("UPDATE attempt SET session_id = ? WHERE id = ?");
    const bridge = db.prepare(
      `INSERT INTO attempt_session (attempt_id, session_id, bound_at)
       VALUES (?, ?, ?)
       ON CONFLICT (attempt_id, session_id) DO NOTHING`,
    );
    db.transaction(() => {
      setCurrent.run(sessionId, attemptId);
      bridge.run(attemptId, sessionId, Date.now());
    })();
  } catch (err) {
    console.warn(`[fleet] attempt session bind failed: ${(err as Error).message}`);
  }
}

/** Stamp the end of an attempt. Idempotent by guarding on `ended_at IS NULL`,
 *  so a driver that both exits and is disposed at shutdown keeps the first
 *  (real) end time instead of having its duration stretched by teardown. */
export function closeAttempt(
  attemptId: string,
  totals: { costUsd?: number | null } = {},
): void {
  try {
    getDb()
      .prepare(
        `UPDATE attempt
            SET ended_at    = ?,
                duration_ms = ? - started_at,
                cost_usd    = COALESCE(?, cost_usd)
          WHERE id = ? AND ended_at IS NULL`,
      )
      .run(Date.now(), Date.now(), totals.costUsd ?? null, attemptId);
  } catch (err) {
    console.warn(`[fleet] attempt close failed: ${(err as Error).message}`);
  }
}

/** Accumulate reported cost onto a live attempt. Providers report per-turn
 *  cost and one process serves many turns, so this sums rather than replaces —
 *  and a provider that reports no cost (codex, kimi) leaves the column null
 *  instead of writing a fake zero. */
export function addAttemptCost(attemptId: string, costUsd: number): void {
  try {
    getDb()
      .prepare(
        "UPDATE attempt SET cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?",
      )
      .run(costUsd, attemptId);
  } catch (err) {
    console.warn(`[fleet] attempt cost failed: ${(err as Error).message}`);
  }
}
