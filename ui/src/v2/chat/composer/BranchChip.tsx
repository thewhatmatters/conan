/**
 * BranchChip — the composer's branch indicator. Paper `S5-0` node UX-0
 * (icon V7-0 + label V2-0), read with `get_computed_styles`:
 *
 *   pill      32px tall · 16px radius · 8px block / 12px inline padding · 8 gap
 *   icon      lucide `git-branch`, 16px, stroke #A3A3A3
 *   label     Figtree 12 / 500 / #A3A3A3, single line
 *
 * No background: the chip reads as quiet metadata on the composer body, which
 * is why the artboard gives it the muted step for BOTH icon and label. The
 * wrapper sets `color` from the token and the icon inherits it through
 * `currentColor`, so the two can never drift (docs §8 "custom tones").
 *
 * Read-only by design (US-302): switching branch is a shell/toolbar concern.
 * Absent — not empty, not "no branch" — when the thread's directory is not a
 * repo or the probe hasn't landed, so the chip never states something untrue.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { GitBranch } from "lucide-react";

export interface BranchChipProps {
  /** Current branch, or null when the directory is not a repo / not probed. */
  branch: string | null;
  /** Uncommitted-file count — surfaced to assistive tech, not drawn (S5-0
   *  draws the name alone). */
  dirty?: number;
}

const styles = stylex.create({
  pill: {
    borderRadius: "var(--conan-radius-pill)",
    color: "var(--conan-icon-muted)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    maxWidth: "100%",
    minWidth: 0,
  },
});

const ICON = 16;

export default function BranchChip({ branch, dirty = 0 }: BranchChipProps) {
  if (!branch) return null;

  return (
    <HStack
      align="center"
      hAlign="center"
      gap={2}
      paddingBlock={2}
      paddingInline={3}
      xstyle={styles.pill}
      data-slot="branch-chip"
      aria-label={
        dirty > 0
          ? `Branch ${branch}, ${dirty} uncommitted`
          : `Branch ${branch}`
      }
    >
      <GitBranch size={ICON} aria-hidden />
      {/* `maxLines={1}` is the artboard's line-clamp-1 (V2-0) — and gives a
          long branch name a truncation tooltip for free. */}
      <Text type="supporting" weight="medium" color="secondary" maxLines={1}>
        {branch}
      </Text>
    </HStack>
  );
}
