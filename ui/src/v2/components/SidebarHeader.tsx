/**
 * SidebarHeader — Paper RJ-0 node 70-0 (the sidebar's 64px header band).
 *
 * T0 STUB (owned by US-002).
 *
 * ⚠️ DESIGN CHANGED UNDER THE PRD. `prd-conan-v2-astryx.json` still describes
 * this slot as "logo mark + Conan wordmark" — that was true of the earlier
 * artboard. On RJ-0 the wordmark has MOVED to the window title bar (RK-0,
 * alongside the traffic lights), and node 70-0 now holds nothing but the search
 * field. This component therefore draws the 64px band and composes
 * `SearchInput`; it does not invent a logo the artboard no longer has. See the
 * title-bar note in `App.v2.tsx` for why RK-0 itself is not rendered.
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

export default function SidebarHeader() {
  return (
    <HStack
      align="center"
      gap={1}
      padding={4}
      xstyle={styles.header}
      data-slot="sidebar-header"
    >
      <SearchInput />
    </HStack>
  );
}
