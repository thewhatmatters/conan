// WHA-129 (fleet phase 1a): row IO for the `attempt` table.
//
// One row per agent process actually spawned. Every write here is best-effort:
// a DB failure must never break a chat turn, exactly like the chat_thread
// persistence in src/agent/index.ts. Lineage that costs the user their session
// is worse than lineage with a hole in it.
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import type { ContainmentClass } from "./containment.js";
import { resolveProjectId } from "./project.js";

/** Freeze doc §1.2: one seam, two policies. `chat` skips the fleet predicates
 *  (an interactive turn has no ticket, AC, verifier pair, or round counter);
 *  `fleet-attempt` is a task attempt under lineage and runs all of them. */
export type DispatchContext = "chat" | "fleet-attempt";

export interface AttemptOpen {
  context: DispatchContext;
  provider: string;
  model: string | null;
  permissionMode: string | null;
  containment: ContainmentClass;
  cwd: string | null;
}

/** Insert an attempt row for a spawn that just happened. Returns the new id,
 *  or null if the write failed (the caller keeps running without lineage). */
export function openAttempt(open: AttemptOpen): string | null {
  const id = randomUUID();
  try {
    // WHA-136: resolved here rather than passed in, so every caller of the seam
    // gets the same answer and no spawn path can forget to anchor its attempt.
    const projectId = resolveProjectId(open.cwd);
    getDb()
      .prepare(
        `INSERT INTO attempt
           (id, context, session_id, provider, model, permission_mode,
            containment_observed, cwd, project_id, started_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return id;
  } catch (err) {
    console.warn(`[fleet] attempt open failed: ${(err as Error).message}`);
    return null;
  }
}

/** Backfill the provider's session id once it reports one at init. A process
 *  is spawned before it has a name, so this cannot be done at insert time. */
export function bindAttemptSession(attemptId: string, sessionId: string): void {
  try {
    getDb()
      .prepare("UPDATE attempt SET session_id = ? WHERE id = ?")
      .run(sessionId, attemptId);
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
