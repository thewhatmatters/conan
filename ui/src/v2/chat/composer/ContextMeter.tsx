/**
 * ContextMeter — composer context-window ring (WHA-101).
 *
 * Placement matches v1: left of the send button (`ChatComposer.sendActions`).
 * Honesty rules live in `contextMeterModel.ts` so unit tests pin them without
 * mounting the SVG.
 *
 * StyleX + Astryx HoverCard only — no v1 Tailwind/ProgressCircle.
 */
import * as stylex from "@stylexjs/stylex";
import { HoverCard } from "@astryxdesign/core/HoverCard";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import {
  contextMeterState,
  type ContextMeterVariant,
} from "./contextMeterModel.ts";

export interface ContextMeterProps {
  /** Latest context-window POSITION (input + cached). Null → render nothing. */
  used: number | null;
  /** Provider window size. Null → raw count only, no percentage. */
  windowTokens: number | null;
}

const RADIUS = 11;
const STROKE = 2.5;
const SIZE = RADIUS * 2;
const NORMALIZED = RADIUS - STROKE / 2;
const CIRCUMFERENCE = NORMALIZED * 2 * Math.PI;

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    cursor: "default",
    borderRadius: "var(--conan-radius-pill)",
    // Composer sets pointer-events:none while disabled; the meter is read-only
    // and should still open its card on hover.
    pointerEvents: "auto",
  },
  ring: {
    display: "block",
    transform: "rotate(-90deg)",
  },
  track: {
    fill: "none",
    stroke: "var(--conan-color-border-strong)",
    strokeOpacity: 0.35,
  },
  fillDefault: {
    fill: "none",
    stroke: "var(--conan-color-accent)",
  },
  fillWarning: {
    fill: "none",
    stroke: "var(--conan-color-warning)",
  },
  fillError: {
    fill: "none",
    stroke: "var(--conan-color-error)",
  },
  fillNeutral: {
    fill: "none",
    stroke: "var(--conan-color-status-idle)",
  },
  card: {
    width: 240,
    padding: 12,
    borderRadius: "var(--conan-radius-md, 10px)",
    backgroundColor: "var(--conan-color-surface-raised, var(--color-surface-raised))",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--conan-color-border)",
  },
  barTrack: {
    display: "block",
    height: 6,
    marginTop: 8,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: "var(--conan-color-border)",
  },
  barFill: {
    display: "block",
    height: "100%",
    borderRadius: 999,
  },
  barDefault: {
    backgroundColor: "var(--conan-color-accent)",
  },
  barWarning: {
    backgroundColor: "var(--conan-color-warning)",
  },
  barError: {
    backgroundColor: "var(--conan-color-error)",
  },
  barNeutral: {
    backgroundColor: "var(--conan-color-status-idle)",
    opacity: 0.4,
  },
});

function fillStyle(variant: ContextMeterVariant) {
  switch (variant) {
    case "warning":
      return styles.fillWarning;
    case "error":
      return styles.fillError;
    case "neutral":
      return styles.fillNeutral;
    default:
      return styles.fillDefault;
  }
}

function barStyle(variant: ContextMeterVariant) {
  switch (variant) {
    case "warning":
      return styles.barWarning;
    case "error":
      return styles.barError;
    case "neutral":
      return styles.barNeutral;
    default:
      return styles.barDefault;
  }
}

export default function ContextMeter({ used, windowTokens }: ContextMeterProps) {
  const state = contextMeterState(used, windowTokens);
  if (!state) return null;

  const value = state.pct ?? 0;
  const offset = CIRCUMFERENCE - (value / 100) * CIRCUMFERENCE;
  // Unknown window: still draw a faint full ring so the control has mass, but
  // opacity marks it as non-fill (matches v1's neutral 100% / 0.4 bar).
  const ringOpacity = state.pct == null ? 0.45 : 1;

  const ring = (
    <span
      {...stylex.props(styles.trigger)}
      data-slot="context-meter"
      data-variant={state.variant}
      data-pct={state.pct == null ? "unknown" : String(Math.round(state.pct))}
      role="img"
      aria-label={`Context window: ${state.summary}`}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden
        {...stylex.props(styles.ring)}
      >
        <circle
          cx={RADIUS}
          cy={RADIUS}
          r={NORMALIZED}
          strokeWidth={STROKE}
          {...stylex.props(styles.track)}
        />
        <circle
          cx={RADIUS}
          cy={RADIUS}
          r={NORMALIZED}
          strokeWidth={STROKE}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={state.pct == null ? 0 : offset}
          strokeLinecap="round"
          style={{ opacity: ringOpacity }}
          {...stylex.props(fillStyle(state.variant))}
        />
      </svg>
    </span>
  );

  return (
    <HoverCard
      placement="above"
      alignment="end"
      delay={150}
      label="Context window"
      content={
        <VStack gap={0} xstyle={styles.card} data-slot="context-meter-card">
          <HStack gap={3} justify="between" align="center">
            <Text type="supporting" weight="medium" color="primary">
              Context window
            </Text>
            <Text type="supporting" color="secondary">
              {state.summary}
            </Text>
          </HStack>
          <span {...stylex.props(styles.barTrack)}>
            <span
              {...stylex.props(styles.barFill, barStyle(state.variant))}
              style={{
                width:
                  state.pct != null ? `${Math.max(2, state.pct)}%` : "100%",
              }}
            />
          </span>
          <Text type="supporting" color="secondary">
            {state.detail}
          </Text>
        </VStack>
      }
    >
      {ring}
    </HoverCard>
  );
}
