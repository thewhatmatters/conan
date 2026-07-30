/**
 * ProjectTree — Paper RJ-0 nodes OT-0 (section) / PY-0 · PZ-0 (project groups).
 *
 * T0 STUB (owned by US-003). Data-prop-driven with a placeholder default so the
 * shell has something honest to show; wiring to the real `/api/agent/projects`
 * hooks is a later phase.
 *
 * The artboard's shape: a "Projects" section header carrying two icon actions,
 * then one collapsible group per project. RJ-0 draws BOTH states, and the
 * difference is more than a chevron — an open group's folder is the open-flap
 * icon in the dim tone, a closed one's is a plain folder in the muted tone. Both
 * are reproduced.
 *
 * VERTICAL LANES: every 32px control row ends with a fixed 32px trailing slot,
 * even when it is empty. RJ-0 does this too (its group-header edit affordance
 * sits at `opacity: 0` until hover) and it is what keeps the section header's
 * actions and the group rows on one right-hand lane.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  SquarePen,
} from "lucide-react";
import ThreadRow, { type ThreadRowProps } from "./ThreadRow.tsx";

export interface ProjectGroup {
  name: string;
  isExpanded?: boolean;
  threads?: ThreadRowProps[];
}

export interface ProjectTreeProps {
  groups?: ProjectGroup[];
}

const ICON = 16;

const styles = stylex.create({
  // A 32px control row. `paddingInlineEnd` (not a symmetric inset) is the
  // artboard's: the chevron sits flush with the tree's left edge so nesting
  // reads, while the label gets breathing room before the trailing lane.
  controlRow: {
    borderRadius: "var(--conan-radius-md)",
    height: "var(--conan-control-height)",
  },
  // Asymmetric on purpose, and it is the artboard's: the chevron sits flush with
  // the tree's left edge so nesting reads, and only the trailing side is inset.
  // Astryx's `paddingInline` prop can't express one-sided padding, so it rides
  // xstyle.
  groupInset: {
    paddingInlineEnd: "var(--conan-space-3)",
  },
  // The fixed trailing lane. Present in every row; sometimes invisible.
  actionSlot: {
    borderRadius: "var(--conan-radius-xs)",
    color: "var(--conan-icon-muted)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    width: "var(--conan-control-height)",
  },
  actionSlotHidden: {
    opacity: 0,
  },
  // The section label is the one place in the sidebar RJ-0 goes to full white
  // (#FFFFFF, a step above `primary`) — it anchors the whole tree. That tone is
  // not an Astryx `Text` colour, so the row owns it and the Text inherits.
  sectionLabel: {
    color: "var(--conan-text-strong)",
    flexGrow: 1,
    minWidth: 0,
  },
  // Group header tones. RJ-0 gives the open group the quieter folder — the
  // expanded rows below it are already carrying the emphasis.
  groupOpen: {
    color: "var(--conan-icon-dim)",
  },
  groupClosed: {
    color: "var(--conan-icon-muted)",
  },
});

/** Placeholder content — realistic shapes, drawn from the artboard's own copy. */
const PLACEHOLDER_GROUPS: ProjectGroup[] = [
  {
    name: "Conan",
    isExpanded: true,
    threads: [
      {
        title: "Analyze my project",
        subtitle: "Run serverless code...",
        isSelected: true,
        isRunning: true,
      },
      {
        title: "Code Validation",
        subtitle: "Run the /code-design skill....",
      },
    ],
  },
  { name: ".claude", isExpanded: false },
];

function SectionHeader() {
  return (
    <HStack align="center" xstyle={styles.controlRow}>
      <HStack align="center" xstyle={styles.sectionLabel}>
        <Text weight="medium" color="inherit">
          Projects
        </Text>
      </HStack>
      <HStack align="center" hAlign="center" xstyle={styles.actionSlot}>
        <ArrowDownWideNarrow size={ICON} aria-label="Sort projects" />
      </HStack>
      <HStack align="center" hAlign="center" xstyle={styles.actionSlot}>
        <FolderPlus size={ICON} aria-label="Add project" />
      </HStack>
    </HStack>
  );
}

function Group({ name, isExpanded = false, threads = [] }: ProjectGroup) {
  const Chevron = isExpanded ? ChevronDown : ChevronRight;
  const FolderIcon = isExpanded ? FolderOpen : Folder;
  return (
    <VStack gap={0} data-slot="project-group">
      <HStack align="center">
        <HStack
          align="center"
          gap={1}
          xstyle={[
            styles.controlRow,
            styles.groupInset,
            isExpanded ? styles.groupOpen : styles.groupClosed,
          ]}
        >
          <Chevron size={ICON} aria-hidden />
          <FolderIcon size={ICON} aria-hidden />
          <Text color="secondary">{name}</Text>
        </HStack>
        <HStack
          align="center"
          hAlign="center"
          xstyle={[styles.actionSlot, styles.actionSlotHidden]}
        >
          <SquarePen size={ICON} aria-hidden />
        </HStack>
      </HStack>
      {isExpanded && threads.length > 0 ? (
        <VStack gap={2}>
          {threads.map((thread) => (
            <ThreadRow key={thread.title} {...thread} />
          ))}
        </VStack>
      ) : null}
    </VStack>
  );
}

export default function ProjectTree({
  groups = PLACEHOLDER_GROUPS,
}: ProjectTreeProps) {
  return (
    <VStack gap={0} data-slot="project-tree">
      <SectionHeader />
      {groups.map((group) => (
        <Group key={group.name} {...group} />
      ))}
    </VStack>
  );
}
