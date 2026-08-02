/**
 * V2ThinkingOrb — the submit→first-token thinking state (WHA-90).
 *
 * The gap between sending and the first token is the most anxious moment in the
 * app: control has been handed over and a dead transcript is indistinguishable
 * from a dead process. This fills that gap with a designed presence.
 *
 * WHY A DEPENDENCY. The mark is `thinking-orbs` (MIT, 38 KB unpacked, ZERO
 * runtime dependencies) — the exact reference Randy specified, in its `solving`
 * state. Hand-rolling a match to someone else's tuned canvas motion would be
 * slower, would drift, and would land us re-deriving the two things the package
 * already does correctly:
 *   - `prefers-reduced-motion: reduce` renders a STATIC representative frame
 *     rather than animating, which this ticket requires outright;
 *   - `role="img"` with a per-state aria-label, so the orb is not a silent
 *     decoration to a screen reader.
 * It also pauses offscreen and when the tab is hidden, and shares one clock
 * across instances so multiple orbs beat together instead of shimmering out of
 * phase. Plain 2D canvas arcs — no WebGL, no SVG filters, DPR capped at 2.
 *
 * MOTION DISCIPLINE. The canvas paints inside its own box, so there is no
 * layout thrash in the live transcript regardless of what it draws — a stronger
 * guarantee than the transform/opacity rule the ticket asks for.
 *
 * ESCALATION IS COPY, NOT MOTION. The orb's rhythm never changes; only the
 * label does, and only at three thresholds. Escalating the animation would make
 * a slow turn *look* like a problem, which is the opposite of the goal.
 */
import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { ThinkingOrb } from "thinking-orbs";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";

/**
 * When the label changes, in ms. The orb itself shows immediately — the first
 * seconds of any turn are normal, and a label that early reads as noise on the
 * fast turns that make up most of them.
 */
export const ESCALATION_MS = { label: 2_000, still: 30_000, long: 180_000 };

/** Which copy tier an elapsed duration falls in. Exported for the tests. */
export function tierFor(elapsedMs: number): "silent" | "label" | "still" | "long" {
  if (elapsedMs >= ESCALATION_MS.long) return "long";
  if (elapsedMs >= ESCALATION_MS.still) return "still";
  if (elapsedMs >= ESCALATION_MS.label) return "label";
  return "silent";
}

const COPY: Record<"label" | "still" | "long", string> = {
  label: "Solving…",
  still: "Still working…",
  long: "Still working — this one is taking a while",
};

const styles = stylex.create({
  row: {
    paddingBlock: "var(--conan-space-1)",
  },
});

export interface V2ThinkingOrbProps {
  /** Orb diameter. The package ships two tuned designs, 20 and 64. */
  size?: 20 | 64;
  /** Test seam: fixed elapsed ms instead of a live clock. */
  elapsedMsForTest?: number;
}

export default function V2ThinkingOrb({
  size = 20,
  elapsedMsForTest,
}: V2ThinkingOrbProps) {
  // Three timeouts, not a per-second interval: the label changes at most twice
  // in three minutes, and re-rendering a live transcript 180 times to move a
  // string is exactly the kind of cost this ticket is trying to avoid.
  const [tier, setTier] = useState<ReturnType<typeof tierFor>>(
    elapsedMsForTest == null ? "silent" : tierFor(elapsedMsForTest),
  );

  useEffect(() => {
    if (elapsedMsForTest != null) return;
    const timers = [
      setTimeout(() => setTier("label"), ESCALATION_MS.label),
      setTimeout(() => setTier("still"), ESCALATION_MS.still),
      setTimeout(() => setTier("long"), ESCALATION_MS.long),
    ];
    return () => timers.forEach(clearTimeout);
  }, [elapsedMsForTest]);

  return (
    <HStack gap={2} align="center" data-slot="v2-thinking-orb" data-tier={tier} xstyle={styles.row}>
      <ThinkingOrb state="solving" size={size} />
      {tier === "silent" ? null : (
        <Text type="supporting" color="secondary">
          {COPY[tier]}
        </Text>
      )}
    </HStack>
  );
}
