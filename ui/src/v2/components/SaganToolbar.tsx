import { useRef, type KeyboardEvent, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { OverflowList, type OverflowItem } from "@astryxdesign/core/OverflowList";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { LayoutList, RefreshCw, Workflow } from "lucide-react";

export type SaganTab = "overview" | "pipeline";

const styles = stylex.create({
  shell: {
    backdropFilter: "blur(var(--conan-glass-blur))",
    WebkitBackdropFilter: "blur(var(--conan-glass-blur))",
    backgroundColor: "var(--conan-glass-tint)",
    boxSizing: "border-box",
    containerType: "inline-size",
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
    width: "100%",
    zIndex: 2,
  },
  toolbar: { height: "100%", width: "100%" },
  tabs: { flexShrink: 0 },
  end: {
    alignItems: "center",
    display: "flex",
    flexShrink: 1,
    justifyContent: "flex-end",
    minWidth: "var(--conan-control-height)",
    overflow: "hidden",
    width: "calc(100cqw - 15rem)",
  },
  overflow: { justifyContent: "flex-end", minWidth: 0, width: "100%" },
  status: { whiteSpace: "nowrap" },
  needsYou: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-full)",
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-2)",
    whiteSpace: "nowrap",
  },
});

function updatedLabel(updatedAt: number | null): string {
  if (updatedAt == null) return "Not updated yet";
  return `Updated ${new Date(updatedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

export interface SaganToolbarProps {
  tab: SaganTab;
  onTabChange: (tab: SaganTab) => void;
  needsYouCount: number;
  updatedAt: number | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  /** Stable insertion point for WHA-233. It intentionally renders nothing today. */
  inspectorTab?: ReactNode;
}

export default function SaganToolbar({
  tab,
  onTabChange,
  needsYouCount,
  updatedAt,
  error,
  refreshing,
  onRefresh,
  inspectorTab,
}: SaganToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const update = updatedLabel(updatedAt);
  const announcement = error ?? (refreshing ? "Refreshing Sagan runs" : update);

  const focusVisible = (selector: string) => {
    const candidates = toolbarRef.current?.querySelectorAll<HTMLElement>(selector) ?? [];
    const candidate = [...candidates].find((element) => (
      !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0
    ));
    candidate?.focus();
  };

  const handleTabKeys = (event: KeyboardEvent<HTMLElement>) => {
    const value = (event.target as HTMLElement).dataset.tabValue;
    if (event.key === "ArrowRight" && value === "pipeline") {
      event.preventDefault();
      focusVisible('button[aria-label="More Sagan toolbar options"], button[aria-label="Refresh Sagan runs"]');
    } else if (event.key === "ArrowLeft" && value === "overview") {
      event.preventDefault();
      focusVisible('button[aria-label="Refresh Sagan runs"]');
    }
  };

  const handleEndKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const label = (event.target as HTMLElement).getAttribute("aria-label");
    if (event.key === "ArrowRight" && label === "More Sagan toolbar options") {
      event.preventDefault();
      focusVisible('button[aria-label="Refresh Sagan runs"]');
    } else if (event.key === "ArrowRight" && label === "Refresh Sagan runs") {
      event.preventDefault();
      focusVisible('button[data-tab-value="overview"]');
    } else if (event.key === "ArrowLeft" && label === "Refresh Sagan runs") {
      event.preventDefault();
      const more = toolbarRef.current?.querySelector<HTMLElement>('button[aria-label="More Sagan toolbar options"]');
      if (more && more.getClientRects().length > 0 && !more.closest('[aria-hidden="true"]')) more.focus();
      else focusVisible('button[data-tab-value="pipeline"]');
    } else if (event.key === "ArrowLeft" && label === "More Sagan toolbar options") {
      event.preventDefault();
      focusVisible('button[data-tab-value="pipeline"]');
    }
  };

  const overflowRenderer = (items: OverflowItem[]) => (
    <MoreMenu
      label="More Sagan toolbar options"
      alignment="end"
      items={items.map(({ index }) => {
        if (index === 0) {
          return { id: "needs-you", label: `${needsYouCount} needs you`, isDisabled: true };
        }
        if (index === 1) {
          return { id: "updated", label: error ?? update, isDisabled: true };
        }
        return {
          id: "refresh",
          label: "Refresh Sagan runs",
          isDisabled: refreshing,
          onClick: () => void onRefresh(),
        };
      })}
    />
  );

  return (
    <div ref={toolbarRef} {...stylex.props(styles.shell)} data-slot="sagan-toolbar-shell">
      <Toolbar
      label="Sagan views and status"
      size="md"
      dividers={["bottom"]}
      xstyle={styles.toolbar}
      data-slot="sagan-toolbar"
      startContent={(
        <TabList
          value={tab}
          onChange={(value) => onTabChange(value as SaganTab)}
          onKeyDown={handleTabKeys}
          aria-label="Sagan views"
          xstyle={styles.tabs}
        >
          <Tab value="overview" label="Overview" icon={<LayoutList size={16} aria-hidden />} />
          <Tab value="pipeline" label="Pipeline" icon={<Workflow size={16} aria-hidden />} />
          {inspectorTab}
        </TabList>
      )}
      endContent={(
        <div {...stylex.props(styles.end)} onKeyDown={handleEndKeys}>
          <OverflowList
            gap={2}
            collapseFrom="start"
            minVisibleItems={1}
            overflowRenderer={overflowRenderer}
            xstyle={styles.overflow}
            data-slot="sagan-toolbar-overflow"
          >
            <Text key="needs-you" type="supporting" xstyle={styles.needsYou}>
              {needsYouCount} needs you
            </Text>
            <Text key="updated" color="secondary" type="supporting" xstyle={styles.status}>
              {error ?? update}
            </Text>
            <IconButton
              key="refresh"
              label="Refresh Sagan runs"
              tooltip="Refresh Sagan runs"
              variant="ghost"
              icon={<RefreshCw size={16} aria-hidden />}
              isLoading={refreshing}
              isDisabled={refreshing}
              clickAction={onRefresh}
            />
          </OverflowList>
          <VisuallyHidden as="div" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </VisuallyHidden>
        </div>
      )}
      />
    </div>
  );
}
