/**
 * ProjectTree — Paper RJ-0 nodes OT-0 (section) / PY-0 · PZ-0 (project groups).
 *
 * Data-prop-driven and PRESENTATIONAL — p2d (US-501) feeds it the real
 * `/api/agent/projects` rows from `App.v2` via `lib/useV2Projects.ts`. The
 * placeholder default below is what a prop-less render shows (the artboard's
 * own copy); the shell never uses it.
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
import { useState } from "react";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreVertical,
} from "lucide-react";
import ThreadRow, { type ThreadRowProps } from "./ThreadRow.tsx";

export interface ProjectGroup {
  /** Stable project id (US-501). Falls back to `name` when absent. */
  id?: string;
  name: string;
  isExpanded?: boolean;
  threads?: ThreadRowProps[];
  onNewThread?: () => void;
  /** Remove the project from Conan (metadata only) — WHA-74. */
  onRemove?: () => void;
}

export interface ProjectTreeProps {
  groups?: ProjectGroup[];
  /** Currently selected thread key (ThreadRow id or title). */
  selectedKey?: string | null;
  /** Fired when the user picks a thread row — App.v2 sets activeThread. */
  onSelectThread?: (thread: ThreadRowProps, projectName: string) => void;
  /**
   * What an EMPTY `groups` array means. "not fetched yet" and "you really have
   * no projects" look identical in the data and must not look identical on
   * screen — a boot flash of "No projects yet" reads as data loss.
   */
  emptyState?: "loading" | "empty" | "error";
  /** Opens the add-project dialog (WHA-74). Omitted → the control is inert. */
  onAddProject?: () => void;
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
  groupHeader: {
    "--project-actions-opacity": 0,
    ":hover": {
      "--project-actions-opacity": 1,
    },
    ":focus-within": {
      "--project-actions-opacity": 1,
    },
  },
  // The fixed trailing lane. Present in every row; sometimes invisible.
  actionSlot: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    borderRadius: "var(--conan-radius-xs)",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "flex",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    justifyContent: "center",
    padding: 0,
    width: "var(--conan-control-height)",
  },
  actionSlotHidden: {
    opacity: 0,
  },
  // The kebab occupies the same trailing lane the compose icon used to, and
  // still rides the header's hover/focus reveal. An OPEN menu pins it visible:
  // the pointer has to leave the row to reach the flyout, and a control that
  // fades out from under its own open menu reads as a glitch.
  menuSlot: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
    opacity: "var(--project-actions-opacity)",
    transition: "opacity var(--conan-duration-fast) ease",
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
  menuSlotOpen: {
    opacity: 1,
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
  groupButton: {
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    cursor: "pointer",
    flexGrow: 1,
    minWidth: 0,
    padding: 0,
    textAlign: "start",
  },
  groupButtonContent: {
    width: "100%",
  },
  // Empty/loading copy sits on the thread rows' text lane, not the chevron's,
  // so it reads as "inside this group" rather than as another group header.
  emptyLine: {
    paddingBlock: "var(--conan-space-2)",
    paddingInlineStart: "var(--conan-space-3)",
  },
});

/** Placeholder content — realistic shapes, drawn from the artboard's own copy. */
const PLACEHOLDER_GROUPS: ProjectGroup[] = [
  {
    name: "Conan",
    isExpanded: true,
    threads: [
      {
        id: "analyze",
        title: "Analyze my project",
        subtitle: "Run serverless code...",
        status: "working",
        provider: "claude",
      },
      {
        id: "code-validation",
        title: "Code Validation",
        subtitle: "Run the /code-design skill....",
        provider: "claude",
      },
    ],
  },
  { name: ".claude", isExpanded: false },
];

function SectionHeader({ onAddProject }: { onAddProject?: () => void }) {
  return (
    <HStack align="center" xstyle={styles.controlRow}>
      <HStack align="center" xstyle={styles.sectionLabel}>
        <Text weight="medium" color="inherit">
          Projects
        </Text>
      </HStack>
      {/* Sort is still inert — US-504 owns it and is deferred. Left as-is
          rather than half-wired, so it doesn't read as shipped. */}
      <button
        type="button"
        aria-label="Sort projects"
        {...stylex.props(styles.actionSlot)}
      >
        <ArrowDownWideNarrow size={ICON} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Add project"
        onClick={onAddProject}
        disabled={!onAddProject}
        {...stylex.props(styles.actionSlot)}
      >
        <FolderPlus size={ICON} aria-hidden />
      </button>
    </HStack>
  );
}

function threadKey(thread: ThreadRowProps): string {
  return thread.id ?? thread.title;
}

function Group({
  name,
  isExpanded = false,
  threads = [],
  selectedKey,
  onSelectThread,
  onNewThread,
  onRemove,
}: ProjectGroup & {
  selectedKey?: string | null;
  onSelectThread?: (thread: ThreadRowProps, projectName: string) => void;
}) {
  const [expanded, setExpanded] = useState(isExpanded);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const FolderIcon = expanded ? FolderOpen : Folder;
  return (
    <VStack gap={0} data-slot="project-group">
      <HStack
        align="center"
        data-slot="project-group-header"
        {...stylex.props(styles.groupHeader)}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
          onClick={() => setExpanded((value) => !value)}
          {...stylex.props(styles.groupButton)}
        >
          <HStack
            align="center"
            gap={1}
            xstyle={[
              styles.controlRow,
              styles.groupInset,
              styles.groupButtonContent,
              expanded ? styles.groupOpen : styles.groupClosed,
            ]}
          >
            <Chevron size={ICON} aria-hidden />
            <FolderIcon size={ICON} aria-hidden />
            <Text color="secondary">{name}</Text>
          </HStack>
        </button>
        {onNewThread || onRemove ? (
          <HStack
            xstyle={[styles.menuSlot, isMenuOpen && styles.menuSlotOpen]}
            data-slot="project-actions"
            data-menu-open={isMenuOpen ? "true" : undefined}
          >
            <DropdownMenu
              isMenuOpen={isMenuOpen}
              onOpenChange={setIsMenuOpen}
              button={{
                label: `Actions for ${name}`,
                icon: <MoreVertical size={ICON} aria-hidden />,
                isIconOnly: true,
                variant: "ghost",
                size: "sm",
              }}
              hasChevron={false}
              placement="below"
              items={[
                {
                  label: "New chat",
                  onClick: onNewThread ?? undefined,
                  isDisabled: !onNewThread,
                },
                { type: "divider" },
                {
                  label: "Remove project",
                  onClick: onRemove ?? undefined,
                  isDisabled: !onRemove,
                },
              ]}
            />
          </HStack>
        ) : null}
      </HStack>
      {expanded ? (
        threads.length > 0 ? (
          <VStack gap={2}>
            {threads.map((thread) => {
              const key = threadKey(thread);
              return (
                <ThreadRow
                  key={key}
                  {...thread}
                  isSelected={
                    selectedKey != null ? selectedKey === key : thread.isSelected
                  }
                  onSelect={() => onSelectThread?.(thread, name)}
                />
              );
            })}
          </VStack>
        ) : (
          // v1's copy verbatim — an expanded project with nothing in it must
          // say so, or it reads as a tree that failed to load.
          <VStack gap={0} xstyle={styles.emptyLine} data-slot="project-empty">
            <Text type="supporting" color="secondary">
              No chats yet.
            </Text>
          </VStack>
        )
      ) : null}
    </VStack>
  );
}

const EMPTY_COPY: Record<NonNullable<ProjectTreeProps["emptyState"]>, string> = {
  loading: "Loading projects…",
  empty: "No projects yet.",
  error: "Couldn't reach the gateway.",
};

export default function ProjectTree({
  groups = PLACEHOLDER_GROUPS,
  selectedKey = null,
  onSelectThread,
  emptyState = "empty",
  onAddProject,
}: ProjectTreeProps) {
  // Default selection wash for the artboard placeholder when the parent has
  // not yet set an active thread — keeps the shell looking selected at rest.
  const effectiveSelected =
    selectedKey ?? (onSelectThread ? null : "analyze");

  return (
    <VStack gap={0} data-slot="project-tree">
      <SectionHeader onAddProject={onAddProject} />
      {groups.length === 0 ? (
        <VStack gap={2} xstyle={styles.emptyLine} data-slot="project-tree-empty">
          <Text type="supporting" color="secondary">
            {EMPTY_COPY[emptyState]}
          </Text>
          {/* The header's icon is a 32px target most people never look at with
              zero rows on screen. An empty tree gets a named way out. */}
          {emptyState === "empty" && onAddProject ? (
            <HStack>
              <Button
                label="Add your first project"
                variant="secondary"
                size="sm"
                onClick={onAddProject}
              />
            </HStack>
          ) : null}
        </VStack>
      ) : (
        groups.map((group) => (
          <Group
            key={group.id ?? group.name}
            {...group}
            selectedKey={effectiveSelected}
            onSelectThread={onSelectThread}
          />
        ))
      )}
    </VStack>
  );
}
