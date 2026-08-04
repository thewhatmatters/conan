/**
 * SidebarHeader — Paper RJ-0 node 70-0 (the sidebar's 64px header band).
 *
 * Draws the fixed 64px band at the top of `Sidebar` and composes `SearchInput`.
 * On RJ-0 the wordmark lives in the window title bar (RK-0), so this band holds
 * nothing but search. The palette opener callback is threaded from App.v2
 * (WHA-70) so ⌘K and the field share one open state.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import SearchInput from "./SearchInput.tsx";

const styles = stylex.create({
  // 70-0: a fixed 64px band on the sidebar tone. It must not shrink when the
  // project tree below it overflows, hence the explicit flexShrink.
  header: {
    backgroundColor: "var(--conan-color-sidebar)",
    flexShrink: 0,
    height: "var(--conan-sidebar-header-height)",
    overflow: "clip",
  },
});

export interface SidebarHeaderProps {
  onOpenPalette?: () => void;
}

export default function SidebarHeader({ onOpenPalette }: SidebarHeaderProps) {
  return (
    <HStack
      align="center"
      gap={1}
      padding={4}
      xstyle={styles.header}
      data-slot="sidebar-header"
    >
      <SearchInput onOpenPalette={onOpenPalette} />
    </HStack>
  );
}
