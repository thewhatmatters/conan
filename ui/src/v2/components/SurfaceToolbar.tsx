import { type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";

const styles = stylex.create({
  bar: {
    boxSizing: "border-box",
    borderBottomColor: "var(--conan-color-border)",
    borderBottomStyle: "solid",
    borderBottomWidth: "var(--conan-border-width)",
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
    width: "100%",
  },
  barBorderless: {
    borderBottomWidth: 0,
  },
  row: {
    height: "var(--conan-control-height)",
    minWidth: 0,
  },
});

export interface SurfaceToolbarProps {
  /** Content for the left side of the toolbar (e.g. Actions menu). */
  left?: ReactNode;
  /** Content for the right side of the toolbar (e.g. surface name or workflow controls). */
  right?: ReactNode;
  /** Optional data slot for the bar element. */
  dataSlot?: string;
  /** When true, the bottom border is omitted so a parent rule can draw the edge (e.g. a glass overlay header). */
  borderless?: boolean;
}

export default function SurfaceToolbar({
  left,
  right,
  dataSlot = "surface-toolbar",
  borderless = false,
}: SurfaceToolbarProps) {
  return (
    <HStack
      align="center"
      justify="between"
      gap={0.5}
      padding={4}
      xstyle={[styles.bar, borderless && styles.barBorderless]}
      data-slot={dataSlot}
    >
      {left ? (
        <HStack
          gap={0.5}
          align="center"
          xstyle={styles.row}
          data-slot="surface-toolbar-left"
        >
          {left}
        </HStack>
      ) : null}
      {right ? (
        <HStack
          gap={0.5}
          align="center"
          justify="end"
          xstyle={styles.row}
          data-slot="surface-toolbar-right"
        >
          {right}
        </HStack>
      ) : null}
    </HStack>
  );
}
