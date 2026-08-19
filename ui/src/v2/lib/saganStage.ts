import type { SaganRunSummary } from "../../../../src/sagan/api.ts";

/**
 * Pipeline stage vocabulary (WHA-144). Extracted from `SaganPipeline.tsx` by
 * WHA-226 so Overview tiles can split Running-now without importing a surface
 * component — same rule WHA-169 applied when it pulled `sectionFor` into
 * `lib/saganSection.ts`.
 */
export type SaganStage = "build" | "critique" | "verify" | "promote";

const has = (value: string, ...needles: string[]): boolean =>
  needles.some((needle) => value.includes(needle));

/**
 * Which of the four stages a run currently sits in.
 *
 * Lanes and phases are OPEN STRINGS in the ledger — `projectLedger` says so
 * outright ("Never an enum"), and the reference ledger at `thewhatmatters/sagan`
 * @ `ab2cb8d` carries `frontend`, `critique`, `verify`, `design` and `done`
 * across its lanes, with a `design` lane that has no role file at all. So the
 * mapping is a heuristic over substrings, resolved in this order — LAST stage
 * first, so a run that has reached the gate is not dragged back by a stale lane:
 *
 *   1. **Promote Gate** — an open decision on a gate named `promote*` (the
 *      human gate `sagan.yaml` declares), or a lane/phase saying the work has
 *      landed: `done`, `merged`, `promote(d)`, `ship`, `release`, `complete`.
 *   2. **Verify** — lane or phase mentions `verify`, `qa` or `test`.
 *   3. **Critique** — lane or phase mentions `critique`, `critic` or `review`.
 *   4. **Build** — EVERYTHING ELSE, including `frontend`, `design`, a null
 *      lane, and any lane a future Sagan build invents. Build is the default
 *      on purpose: an unknown lane is work in progress, and dropping it off the
 *      board entirely would be the one failure mode a pipeline must not have.
 *
 * Note the asymmetry with `openDecisions`: only a PROMOTE gate moves a run's
 * stage. A gate like `art-direction-approval` (also in the reference ledger)
 * fires mid-build and only changes the node's STATE to `approval`.
 */
export function stageFor(run: SaganRunSummary): SaganStage {
  const lane = run.lane?.toLowerCase() ?? "";
  const phase = run.phase?.toLowerCase() ?? "";
  if (run.openDecisions.some((decision) => decision.gate.toLowerCase().includes("promote"))) {
    return "promote";
  }
  if (
    has(lane, "done", "merged", "promote", "ship", "release", "complete") ||
    has(phase, "merged", "promoted", "complete", "done")
  ) {
    return "promote";
  }
  if (has(lane, "verify", "qa", "test") || has(phase, "verify")) return "verify";
  if (has(lane, "critique", "critic", "review") || has(phase, "critique")) return "critique";
  return "build";
}
