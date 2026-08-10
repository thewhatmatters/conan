import type { SaganRunSummary } from "../../../../src/sagan/api.ts";

/**
 * The Sagan Overview's five sections, in the order they render.
 *
 * Extracted out of `V2SurfaceBodies.tsx` by WHA-169 so the categorisation rule
 * is a testable pure function instead of a private helper inside a 1,200-line
 * module of six surface components. Nothing about the component's public
 * surface changed — `V2SurfaceBodies.tsx` still exports only its surfaces.
 */
export type SaganSection = "Needs you" | "Running now" | "Up next" | "Blocked" | "Recently completed";

export const SAGAN_SECTIONS: SaganSection[] = [
  "Needs you",
  "Running now",
  "Up next",
  "Blocked",
  "Recently completed",
];

/** A run's position is terminal — it landed. Matched exactly, never by
 *  substring, so `done-ish` lanes are not swept into a finished bucket. */
const TERMINAL_LANES = ["done", "merged"];
const TERMINAL_PHASES = ["done", "merged", "complete", "completed"];

/** The queued vocabulary, matched exactly for the same reason. Shared, term
 *  for term, with the Pipeline tab's `queued` node state. */
const QUEUED_LANES = ["queued", "queue", "backlog"];
const QUEUED_PHASES = ["queued", "backlog", "pending"];

/**
 * Which Overview section a run belongs in.
 *
 * ORDER IS THE RULE (WHA-169 AC4). First match wins, and the order below IS
 * the argument — the bug this replaced was an ordering, not a predicate:
 *
 *  1. `Needs you` — an open decision gate. A human who has been asked a
 *     question outranks everything the machine last said. Unchanged.
 *
 *  2. `Recently completed` — A POSITION BEATS A VERDICT, and this is the
 *     inversion WHA-169 fixes. The verdict check used to run first, so
 *     WHA-140 — merged on Aug 8 — rendered under **Blocked**, because the
 *     last critique recorded against it was the `REVISE` that caused the
 *     revision that shipped. A verdict is a fact about ONE ROUND and can
 *     outlive it; the lane is where the run is NOW. So a terminal lane wins
 *     outright, including over `ESCALATE`: a run that escalated and later
 *     reads `done` is a run somebody acted on.
 *
 *  3. `Blocked` — only a genuine stop, and only two things are one.
 *     `ESCALATE` is the circuit-breaker verdict: nothing moves until a human
 *     decides. An explicit `block` in the lane or the phase is the other, and
 *     note it is a POSITION rather than a verdict — which is exactly why it
 *     survives into a bucket the other two verdicts leave.
 *     `REVISE` and `NEEDS_EVIDENCE` are deliberately absent. REVISE loops
 *     back to build inside the round cap; NEEDS_EVIDENCE routes to verify.
 *     Both name a station that runs immediately, so both fall through to
 *     `Running now` — and the row keeps printing the verdict, so "a critic
 *     sent this back" stays legible without claiming nothing is happening.
 *
 *  4. `Up next` — the queued vocabulary above.
 *
 *  5. `Running now` — the default. An unknown lane is work in progress; a run
 *     never disappears off the board for failing to match a known word.
 *
 * KNOWN DIVERGENCE: the Pipeline tab's `nodeStateFor` (`SaganPipeline.tsx`)
 * still buckets `REVISE`/`NEEDS_EVIDENCE` as `blocked`, so the same run can
 * read Running here and Blocked there. WHA-169 is scoped to this function;
 * reconciling the two vocabularies needs its own ticket.
 */
export function sectionFor(run: SaganRunSummary): SaganSection {
  const lane = run.lane?.toLowerCase() ?? "";
  const phase = run.phase?.toLowerCase() ?? "";
  const verdict = run.verdict?.toUpperCase() ?? "";
  if (run.openDecisions.length > 0) return "Needs you";
  if (TERMINAL_LANES.includes(lane) || TERMINAL_PHASES.includes(phase)) return "Recently completed";
  if (verdict === "ESCALATE" || lane.includes("block") || phase.includes("block")) return "Blocked";
  if (QUEUED_LANES.includes(lane) || QUEUED_PHASES.includes(phase)) return "Up next";
  return "Running now";
}
