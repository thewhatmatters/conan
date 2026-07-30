/**
 * Sidebar — Paper RJ-0 node 4M-0. Composition file for the sidebar region.
 *
 * T0 (this file) wires the region; US-002 (header/search), US-003 (tree/rows) and
 * US-004 (footer buttons) each implement their own leaf under `components/` and
 * DO NOT touch this file. That split is what keeps parallel worktrees from
 * colliding on one shell (contract §4.4); US-007 owns the integration pass.
 *
 * The artboard's structure is three bands with `justify-content: space-between`:
 * a fixed 64px search header, a growing project tree, and a footer pinned to the
 * bottom. Only the middle band scrolls — that is deliberate, and it is why the
 * header and footer carry explicit `flexShrink: 0`.
 *
 * Note what RJ-0 does NOT have: a divider between sidebar and main. Separation
 * comes from the content well's own tone and its 24px corner, so `hasDivider` is
 * off — adding one would read as a seam the design doesn't want.
 */
import * as stylex from "@stylexjs/stylex";
import { LayoutPanel } from "@astryxdesign/core/Layout";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import SidebarHeader from "./components/SidebarHeader.tsx";
import ProjectTree from "./components/ProjectTree.tsx";
import SettingsFooter from "./components/SettingsFooter.tsx";

const styles = stylex.create({
  panel: {
    backgroundColor: "var(--conan-color-sidebar)",
    overflow: "clip",
  },
  // `minHeight: 0` is the flex-scroll reset — without it the tree grows the
  // column instead of scrolling inside it, and the footer walks off-screen.
  body: {
    flexGrow: 1,
    minHeight: 0,
  },
  // 7L-0: the footer band. Settings is the ONLY affordance RJ-0 draws down here
  // — new chat is not on the artboard, so `NewChatButton` stays unmounted (the
  // leaf file is kept for a later surface). The band's inset and tone belong
  // here; the button itself is its own leaf file.
  footer: {
    backgroundColor: "var(--conan-color-sidebar)",
    flexShrink: 0,
    overflow: "clip",
  },
});

export default function Sidebar() {
  return (
    <LayoutPanel
      width="var(--conan-sidebar-width)"
      padding={0}
      isScrollable={false}
      hasDivider={false}
      role="navigation"
      label="Projects and threads"
      xstyle={styles.panel}
    >
      <VStack height="100%" gap={0} justify="between" data-slot="sidebar">
        <SidebarHeader />
        <VStack isScrollable padding={4} gap={4} xstyle={styles.body}>
          <ProjectTree />
        </VStack>
        <VStack padding={4} gap={4} xstyle={styles.footer}>
          {/* The HStack is load-bearing: it keeps the Settings pill at content
              width. Dropping it lets the VStack stretch the pill edge-to-edge. */}
          <HStack align="center" gap={1}>
            <SettingsFooter />
          </HStack>
        </VStack>
      </VStack>
    </LayoutPanel>
  );
}
