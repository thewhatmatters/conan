/**
 * Breadcrumb — Paper RJ-0 node EL-0 (the toolbar's project / thread crumb).
 *
 * T0 STUB (owned by US-005). The parent crumb is a real focusable button so a
 * keyboard / AT user can navigate "back to project"; the leaf is static current-
 * page text. v1's `ThreadToolbar` breadcrumb is the behaviour reference for the
 * later wiring pass.
 *
 * RJ-0's hierarchy here is carried entirely by colour: the parent crumb and its
 * folder icon are the DIM step (#737373), the separator likewise, and only the
 * leaf is full white. Two of those three tones are not Astryx `Text` colours, so
 * each crumb group sets `color` once via `xstyle` and its children take
 * `color="inherit"` — the icon picks the same value up through `currentColor`.
 * (`Text`'s `xstyle` is deliberately restricted to layout properties, so this
 * indirection is the sanctioned way to reach a custom tone.)
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { FolderOpen } from "lucide-react";

export interface BreadcrumbProps {
  /** The project the thread belongs to. */
  project?: string;
  /** The thread's title — the leaf, and the only crumb at full contrast. */
  thread?: string;
  /** Optional handler when the parent (project) crumb is activated. */
  onProjectClick?: () => void;
}

const styles = stylex.create({
  crumbs: {
    flexShrink: 0,
  },
  dim: {
    color: "var(--conan-text-dim)",
  },
  // Parent crumb is a real <button> — reset UA chrome so it still reads as the
  // artboard's dim text+icon pair, not a filled control. Layout matches the
  // surrounding HStack gap=1 row (inline-flex + 4px gap).
  parentButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    borderWidth: 0,
    color: "var(--conan-text-dim)",
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    font: "inherit",
    gap: "var(--conan-space-1)",
    margin: 0,
    padding: 0,
  },
  leaf: {
    color: "var(--conan-text-strong)",
  },
});

export default function Breadcrumb({
  project = "Conan",
  thread = "Analyze my project",
  onProjectClick,
}: BreadcrumbProps) {
  return (
    <HStack align="center" gap={1} wrap="wrap" xstyle={styles.crumbs} data-slot="breadcrumb">
      <button
        type="button"
        {...stylex.props(styles.parentButton)}
        aria-label={`Back to ${project}`}
        onClick={onProjectClick}
        data-slot="breadcrumb-parent"
      >
        <FolderOpen size={16} aria-hidden />
        <Text color="inherit">{project}</Text>
      </button>
      <HStack align="center" gap={1} xstyle={styles.dim}>
        <Text color="inherit" aria-hidden>
          /
        </Text>
      </HStack>
      <HStack align="center" xstyle={styles.leaf}>
        <Text color="inherit">{thread}</Text>
      </HStack>
    </HStack>
  );
}
