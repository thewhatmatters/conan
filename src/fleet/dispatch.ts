// WHA-129 (fleet phase 1a): the single dispatch seam.
//
// Freeze doc §1.1: ALL agent process spawns — interactive chat and fleet
// attempts alike — go through here. There is deliberately no second door. The
// enforced predicates that land in later phases (round caps, containment
// floors, builder != verifier) are dispatch-time checks, and they are only
// enforcement if every spawn passes this function; a second `createDriver`
// call site anywhere would make all of them advisory.
//
// This phase enforces nothing. It resolves containment, records the attempt,
// and owns the spawn gate. The predicates hang off it next.
import type { AgentDriver, AgentEvent } from "../agent/driver.js";
import type { ProviderEntry } from "../agent/registry.js";
import {
  addAttemptCost,
  bindAttemptSession,
  closeAttempt,
  openAttempt,
  type DispatchContext,
} from "./attempts.js";
import { resolveContainment, type ContainmentClass } from "./containment.js";

/** What the caller resolved before a process exists: which provider, and the
 *  launch parameters that decide containment. */
export interface SpawnPlan {
  provider: ProviderEntry;
  /** Launch model id, or null for the provider default. */
  model: string | null;
  /** Permission-mode id requested at launch, or null for the default. */
  permissionMode: string | null;
  cwd: string | null;
}

export interface Spawned {
  driver: AgentDriver;
  provider: ProviderEntry;
  /** Null when the lineage write failed — the session still runs. */
  attemptId: string | null;
  containment: ContainmentClass;
}

export interface Dispatcher {
  /** Spawn this connection's driver, or return the one already spawned.
   *
   *  `plan` is only invoked on the first call: resolving a provider is async
   *  (an install probe), so a second prompt racing the first must await the
   *  same in-flight build rather than starting a second one. That guard is the
   *  reason this lives here — one driver AND one attempt row per connection is
   *  a property of the seam, not of its caller. */
  spawn(plan: () => Promise<SpawnPlan>): Promise<Spawned>;
  /** The spawn for this connection, or null if no prompt has arrived yet. */
  current(): Spawned | null;
  /** Record cost the provider reported for a completed turn. */
  recordCost(costUsd: number): void;
  /** Bind the provider's session id once it reports one at init. */
  bindSession(sessionId: string): void;
  /** Stamp the attempt closed and drop it from the live set. Idempotent. */
  dispose(): void;
}

/** Every dispatcher with a live process. Kept here rather than in the WS
 *  handler so shutdown closes attempt rows through the same seam that opened
 *  them — otherwise a killed gateway leaves attempts recorded as running
 *  forever and every duration in the ledger is a lie. */
const live = new Set<Dispatcher>();

export function createDispatcher(opts: {
  context: DispatchContext;
  emit: (e: AgentEvent) => void;
  fallbackCwd: () => string | null;
}): Dispatcher {
  let spawned: Spawned | null = null;
  let building: Promise<Spawned> | null = null;
  let disposed = false;

  const dispatcher: Dispatcher = {
    spawn(plan) {
      if (spawned) return Promise.resolve(spawned);
      if (!building) {
        building = (async () => {
          const p = await plan();
          // Resolving a provider is async, so the connection can close while
          // this is in flight. Everything below is synchronous, so this one
          // check closes the whole window: without it the spawn would go on to
          // start a real process for a socket that is gone and open an attempt
          // row that nothing can ever close — `dispose()` has already run, so
          // both a later dispose and the shutdown sweep hit its `disposed`
          // guard and no-op.
          if (disposed) {
            throw new Error("dispatch aborted: connection closed during spawn");
          }
          const containment = resolveContainment(
            p.provider.id,
            p.permissionMode ?? undefined,
          );
          const driver = p.provider.createDriver(opts.emit, opts.fallbackCwd);
          const attemptId = openAttempt({
            context: opts.context,
            provider: p.provider.id,
            model: p.model,
            permissionMode: p.permissionMode,
            containment,
            cwd: p.cwd,
          });
          spawned = { driver, provider: p.provider, attemptId, containment };
          live.add(dispatcher);
          return spawned;
        })();
        // A refused build (unknown/uninstalled provider) must not poison the
        // connection — clear the gate so the user can retry with another
        // provider. The rejection itself still propagates to this caller.
        building.catch(() => {
          building = null;
        });
      }
      return building;
    },
    current: () => spawned,
    recordCost(costUsd) {
      if (spawned?.attemptId) addAttemptCost(spawned.attemptId, costUsd);
    },
    bindSession(sessionId) {
      if (spawned?.attemptId) bindAttemptSession(spawned.attemptId, sessionId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      live.delete(dispatcher);
      if (spawned) {
        if (spawned.attemptId) closeAttempt(spawned.attemptId);
        spawned.driver.dispose();
      }
    },
  };

  return dispatcher;
}

/** Tear down every live spawn (gateway shutdown). */
export function disposeAllDispatched(): void {
  for (const dispatcher of [...live]) dispatcher.dispose();
  live.clear();
}
