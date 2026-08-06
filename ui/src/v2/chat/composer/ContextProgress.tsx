/**
 * ContextProgress — Full Featured composer context-window progress (WHA-119).
 *
 * Lives in ChatComposer.headerContext, which Astryx explicitly reserves for
 * context usage / ProgressBar. The pure WHA-101 model remains the single source
 * for percentage, threshold, and unknown-window honesty.
 */
import * as stylex from "@stylexjs/stylex";
import { HoverCard } from "@astryxdesign/core/HoverCard";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  contextMeterState,
  type ContextMeterVariant,
} from "./contextMeterModel.ts";

export interface ContextProgressProps {
  used: number | null;
  windowTokens: number | null;
}

const styles = stylex.create({
  root: {
    minWidth: 0,
    width: "min(220px, 42vw)",
  },
  unknown: {
    color: "var(--conan-text-secondary)",
    fontSize: "var(--conan-text-small)",
    whiteSpace: "nowrap",
  },
  card: {
    backgroundColor: "var(--conan-color-surface-raised)",
    borderColor: "var(--conan-color-border)",
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "solid",
    borderWidth: 1,
    padding: "var(--conan-space-3)",
    width: 260,
  },
});

function progressVariant(variant: ContextMeterVariant) {
  switch (variant) {
    case "warning":
      return "warning" as const;
    case "error":
      return "error" as const;
    case "neutral":
      return "neutral" as const;
    default:
      return "accent" as const;
  }
}

export default function ContextProgress({ used, windowTokens }: ContextProgressProps) {
  const state = contextMeterState(used, windowTokens);
  if (!state) return null;

  const content = (
    <div
      {...stylex.props(styles.root)}
      data-slot="context-progress"
      data-variant={state.variant}
      data-pct={state.pct == null ? "unknown" : String(Math.round(state.pct))}
    >
      {state.pct == null ? (
        <span {...stylex.props(styles.unknown)}>{state.summary}</span>
      ) : (
        <ProgressBar
          label="Context"
          isLabelHidden
          value={state.pct}
          max={100}
          variant={progressVariant(state.variant)}
        />
      )}
    </div>
  );

  return (
    <HoverCard
      placement="above"
      alignment="end"
      delay={150}
      label="Context window"
      content={
        <VStack gap={1} xstyle={styles.card}>
          <Text type="supporting" weight="medium" color="primary">
            Context window · {state.summary}
          </Text>
          <Text type="supporting" color="secondary">
            {state.detail}
          </Text>
        </VStack>
      }
    >
      {content}
    </HoverCard>
  );
}
