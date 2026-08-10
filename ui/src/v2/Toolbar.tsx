/**
 * Toolbar — Paper RJ-0 node EK-0. Composition file for the top toolbar.
 *
 * WHA-158 swaps surface navigation into the top bar: crumb left, Chat/surfaces
 * tab strip right. The workflow controls (Actions/Open/Commit & Push) now live
 * inside the Chat surface only.
 *
 * The toolbar sits on the app tone (#1B1B1B), NOT on the lifted content well:
 * the well begins below it, which is what lets its 24px corner show.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import Breadcrumb from "./components/Breadcrumb.tsx";
import SurfaceTabs, { type SurfaceTabsProps } from "./components/SurfaceTabs.tsx";
import type { BreadcrumbProps } from "./components/Breadcrumb.tsx";

const styles = stylex.create({
  toolbar: {
    flexShrink: 0,
    height: "var(--conan-toolbar-height)",
    overflow: "clip",
  },
  breadcrumbSlot: {
    display: {
      default: "flex",
      "@media (max-width: 600px)": "none",
    },
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  tabsSlot: {
    flexShrink: 0,
    minWidth: 0,
  },
});

// WHA-104: the crumb's thread segment switches threads, so the toolbar also
// forwards the sibling list and the selection callback. It stays a pure
// pass-through — the shell (App.v2) owns the data, as it does for the sidebar.
export interface ToolbarProps
  extends Pick<
    BreadcrumbProps,
    "project" | "thread" | "threads" | "activeThreadId" | "onSelectThread"
  >,
    SurfaceTabsProps {}

export default function Toolbar({
  project,
  thread,
  threads,
  activeThreadId,
  onSelectThread,
  tabs,
  saganAvailable,
  onSelect,
  onOpen,
  onClose,
}: ToolbarProps) {
  return (
    <HStack
      align="center"
      justify="between"
      gap={4}
      padding={4}
      xstyle={styles.toolbar}
      data-slot="toolbar"
    >
      <HStack align="center" xstyle={styles.breadcrumbSlot}>
        <Breadcrumb
          project={project}
          thread={thread}
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
        />
      </HStack>
      <HStack align="center" xstyle={styles.tabsSlot}>
        <SurfaceTabs
          tabs={tabs}
          saganAvailable={saganAvailable}
          onSelect={onSelect}
          onOpen={onOpen}
          onClose={onClose}
        />
      </HStack>
    </HStack>
  );
}
