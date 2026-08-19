/**
 * WHA-226 — Overview headline + summary tiles.
 *
 * Tile counts are recounts of `sectionFor()` buckets — one categorisation rule,
 * never two. The Running subtitle splits that same Running-now set with
 * `stageFor` (verify vs everything else) so build + verify always equals the
 * Running tile. Headline counts decisions (Σ openDecisions.length); the Needs
 * you tile counts runs — those diverge on purpose when one run holds two gates.
 */
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";
import { sectionFor } from "./saganSection.ts";
import { stageFor } from "./saganStage.ts";

export type OverviewTileId = "needs-you" | "running" | "blocked";

export interface OverviewTile {
  id: OverviewTileId;
  /** Exact display label from the ticket (Blocked, not Halted). */
  label: "Needs you" | "Running" | "Blocked";
  /** Run count — equals `sectionFor` bucket length for the mapped section. */
  count: number;
  /**
   * Secondary line. Running always shows the build/verify split (including at
   * zero). Needs you / Blocked show a calm zero-state line when empty; null
   * when the count is positive.
   */
  detail: string | null;
}

export interface OverviewTiles {
  tiles: OverviewTile[];
  /** Σ openDecisions.length — the headline's decision load. */
  decisionCount: number;
  headline: string;
}

/** Map a tile to the section it recounts. Labels bind 1:1 to section names
 *  except Running → "Running now". */
export function sectionForTile(id: OverviewTileId): "Needs you" | "Running now" | "Blocked" {
  switch (id) {
    case "needs-you":
      return "Needs you";
    case "running":
      return "Running now";
    case "blocked":
      return "Blocked";
  }
}

/**
 * Headline copy for the decision load.
 * Zero is a distinct calm state — not a pluralised "0 decisions…".
 */
export function decisionHeadline(decisionCount: number): string {
  if (decisionCount <= 0) return "Nothing needs you right now.";
  if (decisionCount === 1) return "1 decision is waiting on you";
  return `${decisionCount} decisions are waiting on you`;
}

/** Among Running-now runs: verify stage vs everything else (build catch-all). */
export function runningSplit(running: readonly SaganRunSummary[]): {
  build: number;
  verify: number;
} {
  let verify = 0;
  for (const run of running) {
    if (stageFor(run) === "verify") verify += 1;
  }
  return { build: running.length - verify, verify };
}

function runningDetail(build: number, verify: number): string {
  return `${build} build · ${verify} verify`;
}

export function overviewTiles(runs: readonly SaganRunSummary[]): OverviewTiles {
  const needsYou: SaganRunSummary[] = [];
  const running: SaganRunSummary[] = [];
  const blocked: SaganRunSummary[] = [];
  let decisionCount = 0;

  for (const run of runs) {
    decisionCount += run.openDecisions.length;
    switch (sectionFor(run)) {
      case "Needs you":
        needsYou.push(run);
        break;
      case "Running now":
        running.push(run);
        break;
      case "Blocked":
        blocked.push(run);
        break;
      default:
        break;
    }
  }

  const split = runningSplit(running);

  return {
    decisionCount,
    headline: decisionHeadline(decisionCount),
    tiles: [
      {
        id: "needs-you",
        label: "Needs you",
        count: needsYou.length,
        detail: needsYou.length === 0 ? "Nothing waiting" : null,
      },
      {
        id: "running",
        label: "Running",
        count: running.length,
        // Always the split — including the calm zero "0 build · 0 verify".
        detail: runningDetail(split.build, split.verify),
      },
      {
        id: "blocked",
        label: "Blocked",
        count: blocked.length,
        detail: blocked.length === 0 ? "Nothing blocked" : null,
      },
    ],
  };
}
