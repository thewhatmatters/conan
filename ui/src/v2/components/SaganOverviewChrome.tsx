/**
 * WHA-229 — lane distribution bars + Overview section chrome.
 *
 * Kept out of `V2SurfaceBodies.tsx` so Nash's WHA-233 shell edits and this
 * ticket's section work collide less. Pure helpers live in
 * `lib/saganOverviewChrome.ts`; this file is the Astryx composition only.
 */
import { type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";
import type { SaganSection } from "../lib/saganSection.ts";
import {
  laneDistribution,
  orderingLabelFor,
  sortRunsForSection,
  type LaneDistribution,
} from "../lib/saganOverviewChrome.ts";

const styles = stylex.create({
  lanePanel: {
    alignItems: "stretch",
    gap: "var(--conan-space-2)",
    width: "100%",
  },
  laneRow: {
    alignItems: "stretch",
    width: "100%",
  },
  totalRow: {
    borderTop: "var(--conan-border-width) solid var(--conan-color-border)",
    paddingBlockStart: "var(--conan-space-2)",
    width: "100%",
  },
  section: {
    alignItems: "stretch",
    width: "100%",
  },
  sectionTrigger: {
    alignItems: "center",
    display: "flex",
    flexGrow: 1,
    gap: "var(--conan-space-2)",
    justifyContent: "space-between",
    minWidth: 0,
    width: "100%",
  },
  sectionLead: {
    alignItems: "center",
    display: "flex",
    flexShrink: 1,
    gap: "var(--conan-space-2)",
    minWidth: 0,
  },
  sectionTitle: {
    color: "var(--conan-text-primary)",
  },
  sectionCount: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-full)",
    minWidth: "var(--conan-icon-size)",
    paddingInline: "var(--conan-space-2)",
    textAlign: "center",
  },
  orderingLabel: {
    color: "var(--conan-text-muted)",
    flexShrink: 0,
    fontSize: "var(--conan-text-small)",
    fontWeight: 500,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  sectionBody: {
    alignItems: "stretch",
    gap: "var(--conan-space-2)",
    paddingBlockStart: "var(--conan-space-2)",
    width: "100%",
  },
  empty: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-text-muted)",
    padding: "var(--conan-space-3)",
  },
});

export function SaganLanePanel({ runs }: { runs: readonly SaganRunSummary[] }) {
  const distribution = laneDistribution(runs);
  // AC6 / Linear AC6: zero-run state has no bar chart of zeros.
  if (distribution.total === 0) return null;
  return <SaganLaneBars distribution={distribution} />;
}

function SaganLaneBars({ distribution }: { distribution: LaneDistribution }) {
  const { lanes, total } = distribution;
  return (
    <VStack
      gap={2}
      xstyle={styles.lanePanel}
      data-slot="sagan-lane-panel"
      aria-label="Lane distribution"
    >
      {lanes.map((lane) => (
        <div key={lane.key} {...stylex.props(styles.laneRow)} data-lane={lane.key}>
          <ProgressBar
            label={lane.label}
            value={lane.count}
            max={total}
            hasValueLabel
            formatValueLabel={(value) => String(value)}
            variant="accent"
          />
        </div>
      ))}
      <div {...stylex.props(styles.totalRow)} data-lane="total">
        <ProgressBar
          label="Total"
          value={total}
          max={total}
          hasValueLabel
          formatValueLabel={(value) => String(value)}
          variant="neutral"
        />
      </div>
    </VStack>
  );
}

export function SaganOverviewSection({
  section,
  rows,
  isOpen,
  onOpenChange,
  renderRow,
}: {
  section: SaganSection;
  rows: readonly SaganRunSummary[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  renderRow: (run: SaganRunSummary) => ReactNode;
}) {
  const ordering = orderingLabelFor(section);
  const ordered = sortRunsForSection(section, rows);

  return (
    <VStack
      gap={0}
      xstyle={styles.section}
      data-slot="sagan-overview-section"
      data-sagan-section={section}
      data-sagan-ordering={ordering}
    >
      <Collapsible
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        data-testid={`sagan-section-${section}`}
        trigger={
          <span {...stylex.props(styles.sectionTrigger)}>
            <span {...stylex.props(styles.sectionLead)}>
              <Text weight="semibold" xstyle={styles.sectionTitle}>
                {section}
              </Text>
              <Text type="supporting" xstyle={styles.sectionCount} data-slot="sagan-section-count">
                {rows.length}
              </Text>
            </span>
            <Text type="supporting" xstyle={styles.orderingLabel} data-slot="sagan-ordering-label">
              {ordering}
            </Text>
          </span>
        }
      >
        <VStack gap={2} xstyle={styles.sectionBody} data-slot="sagan-section-rows">
          {ordered.length > 0 ? (
            ordered.map((run) => renderRow(run))
          ) : (
            <Text type="supporting" xstyle={styles.empty}>
              No runs in this section.
            </Text>
          )}
        </VStack>
      </Collapsible>
    </VStack>
  );
}
