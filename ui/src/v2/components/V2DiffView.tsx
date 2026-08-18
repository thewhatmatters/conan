/**
 * V2DiffView — the approval card's file-edit disclosure (Defect 2).
 *
 * Renders a `FileDiff` (ui/src/lib/diff.ts, shared with v1) as red/green rows
 * in a bounded scroller. Shows a contextual preview first with an
 * expand-to-full control (Randy's decision #1, 2026-08-01); the full file
 * path rides the header unredacted (#3). v1's `DiffView` is the visual
 * reference — this is its Astryx/StyleX port, a shared v2 component because
 * v2's Diff surface will want the same primitive.
 *
 * Degraded diffs (binary / >200k chars → `lines: null`) render as a counts-
 * only summary line, mirroring `buildFileDiff`'s own degrade contract.
 */
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { FileDiff } from "../../lib/diff.ts";

/** Preview rows shown before the user expands — "enough context" without
 *  pushing the action row out of view; the full diff is one click away. */
export const PREVIEW_ROWS = 12;
/** Cap on rendered rows even when expanded — v1 DiffView's precedent, so a
 *  whole-file Write can't mount thousands of DOM nodes. */
export const MAX_DIFF_ROWS = 600;

const styles = stylex.create({
  root: {
    // The diff sits inside a Card that may be a flex item; without this,
    // white-space:pre rows widen the card instead of scrolling (WHA-214).
    minWidth: 0,
    width: "100%",
  },
  scroller: {
    boxSizing: "border-box",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    lineHeight: "20px",
    maxHeight: 320,
    overflow: "auto",
    paddingBlock: 2,
    width: "100%",
  },
  row: {
    paddingInline: "var(--conan-space-3)",
    whiteSpace: "pre",
  },
  add: {
    backgroundColor: "var(--conan-diff-add-bg)",
    color: "var(--conan-diff-add-text)",
  },
  del: {
    backgroundColor: "var(--conan-diff-del-bg)",
    color: "var(--conan-diff-del-text)",
  },
  ctx: {
    color: "var(--conan-text-muted)",
  },
  hunk: {
    color: "var(--conan-text-muted)",
    textAlign: "center",
  },
  marker: {
    opacity: 0.6,
    userSelect: "none",
  },
  note: {
    color: "var(--conan-text-muted)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-3)",
  },
  path: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  statAdd: {
    color: "var(--conan-diff-add-text)",
  },
  statDel: {
    color: "var(--conan-diff-del-text)",
  },
});

/** `+N −M` counts, added in success green and removed in error red. */
export function V2DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <Text type="supporting" hasTabularNumbers>
      <span {...stylex.props(styles.statAdd)}>+{added}</span>{" "}
      <span {...stylex.props(styles.statDel)}>−{removed}</span>
    </Text>
  );
}

export default function V2DiffView({ diff }: { diff: FileDiff }) {
  const [expanded, setExpanded] = useState(false);

  const header = (
    <HStack gap={2} align="center">
      <div {...stylex.props(styles.path)}>
        <Text type="supporting" color="secondary">
          {diff.path}
        </Text>
      </div>
      <V2DiffStat added={diff.added} removed={diff.removed} />
    </HStack>
  );

  // Degraded — binary or oversized content: counts only, no rows to render.
  if (diff.lines === null) {
    return (
      <VStack gap={1} width="100%" data-slot="v2-diff" xstyle={styles.root}>
        {header}
        <div {...stylex.props(styles.note)}>
          {diff.degraded === "binary"
            ? "Binary content — showing counts only."
            : "Change too large to render — showing counts only."}
        </div>
      </VStack>
    );
  }

  const capped = diff.lines.slice(0, MAX_DIFF_ROWS);
  const collapsible = capped.length > PREVIEW_ROWS;
  const shown = expanded || !collapsible ? capped : capped.slice(0, PREVIEW_ROWS);
  const hiddenBeyondCap = diff.lines.length - capped.length;

  return (
    <VStack gap={1} width="100%" data-slot="v2-diff" xstyle={styles.root}>
      {header}
      <div {...stylex.props(styles.scroller)}>
        {shown.map((l, i) =>
          l.type === "hunk" ? (
            <div key={i} {...stylex.props(styles.row, styles.hunk)}>
              ⋯
            </div>
          ) : (
            <div
              key={i}
              {...stylex.props(
                styles.row,
                l.type === "add" && styles.add,
                l.type === "del" && styles.del,
                l.type === "ctx" && styles.ctx,
              )}
            >
              <span {...stylex.props(styles.marker)}>
                {l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}
              </span>
              {l.text}
            </div>
          ),
        )}
        {expanded && hiddenBeyondCap > 0 && (
          <div {...stylex.props(styles.note)}>… {hiddenBeyondCap} more lines</div>
        )}
      </div>
      {collapsible && (
        <HStack gap={2}>
          <Button
            label={expanded ? "Show less" : `Show full diff (+${diff.added} −${diff.removed})`}
            variant="secondary"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          />
        </HStack>
      )}
    </VStack>
  );
}
