/**
 * Toolbar — Paper RJ-0 node EK-0. Composition file for the top toolbar.
 *
 * T0 (this file) wires the region; US-005 implements `Breadcrumb` and
 * `SurfaceTabs` in their own leaf files and does NOT touch this one
 * (contract §4.4).
 *
 * RJ-0's toolbar is a 16px inset around a single 32px control row — which is
 * exactly why it measures 64px, the same as the secondary bar below it. Crumb
 * left, tab strip right, pushed apart by `space-between`.
 *
 * The toolbar sits on the app tone (#1B1B1B), NOT on the lifted content well:
 * the well begins below it, which is what lets its 24px corner show.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import Breadcrumb from "./components/Breadcrumb.tsx";
import SurfaceTabs from "./components/SurfaceTabs.tsx";

const styles = stylex.create({
  toolbar: {
    flexShrink: 0,
    height: "var(--conan-toolbar-height)",
    overflow: "clip",
  },
  // G7-0 — the tab group's own band. It restates the sidebar tone because the
  // strip may overflow the toolbar on a narrow window and needs an opaque
  // ground to scroll against.
  tabGroup: {
    backgroundColor: "var(--conan-color-sidebar)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
});

export default function Toolbar() {
  return (
    <HStack
      align="center"
      justify="between"
      gap={4}
      padding={4}
      xstyle={styles.toolbar}
      data-slot="toolbar"
    >
      <Breadcrumb />
      <HStack align="center" gap={6} xstyle={styles.tabGroup}>
        <SurfaceTabs />
      </HStack>
    </HStack>
  );
}
