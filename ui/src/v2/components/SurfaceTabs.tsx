import { useCallback, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import * as stylex from "@stylexjs/stylex";
import {
  DropdownMenu,
  DropdownMenuItem,
  useDropdownMenuContext,
} from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { Item } from "@astryxdesign/core/Item";
import { Text } from "@astryxdesign/core/Text";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "./astryx/ToggleButton/index.ts";
import {
  Diff,
  Check,
  ChevronDown,
  FileText,
  Globe,
  Layers,
  MessagesSquare,
  MoreVertical,
  PanelLeft,
  PanelRight,
  Orbit,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";

export type SurfaceId = "chat" | "browser" | "terminal" | "diff" | "files" | "sagan";
export type SurfacePlacement = "right" | "left";

/** MIME type used to identify a dragged surface tab during HTML5 drag-and-drop. */
export const SURFACE_DRAG_MIME_TYPE = "application/conan-surface-id";

export interface SurfaceTab {
  id: SurfaceId;
  label: string;
  icon: LucideIcon;
  isCloseable?: boolean;
  isSelected?: boolean;
  isDocked?: boolean;
  isVisuallyActive?: boolean;
  joinedSide?: "start" | "end";
  dockedDescription?: string;
  placement?: SurfacePlacement;
  count?: number;
}

export interface SurfaceTabsProps {
  tabs?: SurfaceTab[];
  saganAvailable?: boolean;
  onSelect?: (id: SurfaceId) => void;
  onOpen?: (id: Exclude<SurfaceId, "chat">) => void;
  onClose?: (id: Exclude<SurfaceId, "chat">) => void;
  onPlacementChange?: (
    id: Exclude<SurfaceId, "chat">,
    placement: SurfacePlacement,
  ) => void;
}

export const SURFACE_OPTIONS: ReadonlyArray<
  Omit<SurfaceTab, "id" | "isSelected" | "placement"> & {
    id: Exclude<SurfaceId, "chat">;
  }
> = [
  { id: "browser", label: "Browser", icon: Globe, isCloseable: true },
  { id: "terminal", label: "Terminal", icon: Terminal, isCloseable: true },
  { id: "diff", label: "Diff", icon: Diff, isCloseable: true },
  { id: "files", label: "Files", icon: FileText, isCloseable: true },
  { id: "sagan", label: "Sagan", icon: Orbit, isCloseable: true },
];

const DEFAULT_TABS: SurfaceTab[] = [
  { id: "chat", label: "Chat", icon: MessagesSquare, isSelected: true },
];
const PLACEMENTS: ReadonlyArray<{
  id: SurfacePlacement;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "right", label: "Right", icon: PanelRight },
  { id: "left", label: "Left", icon: PanelLeft },
];
const ICON = 16;

const styles = stylex.create({
  strip: {
    flexShrink: 1,
    height: "var(--conan-control-height)",
    minWidth: 0,
    overflowX: "auto",
    overscrollBehaviorInline: "contain",
  },
  toggleGroup: {
    flexShrink: 0,
  },
  tab: {
    boxSizing: "border-box",
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    outlineOffset: { default: "0", ":focus-visible": "2px" },
    position: "relative",
    width: "fit-content",
  },
  tabSelected: {
    backgroundColor: "var(--conan-wash-tab-selected)",
    color: "var(--conan-icon-strong)",
  },
  joinedStart: {
    borderEndEndRadius: 0,
    borderStartEndRadius: 0,
  },
  joinedEnd: {
    borderEndStartRadius: 0,
    borderStartStartRadius: 0,
    marginInlineStart: "calc(-1 * var(--conan-space-hair))",
  },
  tabLabel: {
    columnGap: "var(--conan-space-2)",
    justifyContent: "center",
    position: "relative",
    top: "var(--conan-space-hair)",
    whiteSpace: "nowrap",
  },
  dockGroup: {
    borderRadius: "var(--conan-radius-md)",
    boxSizing: "border-box",
    height: "var(--conan-control-height)",
  },
  dockGroupInactive: {
    boxShadow: "inset 0 0 0 var(--conan-border-width) var(--conan-color-border)",
  },
  tabShell: {
    borderRadius: "var(--conan-radius-md)",
    display: "flex",
    overflow: "hidden",
    position: "relative",
  },
  tabActions: {
    alignItems: "center",
    display: "flex",
    height: "var(--conan-control-height)",
    insetInlineEnd: 0,
    justifyContent: "flex-end",
    position: "absolute",
    top: 0,
    width: "var(--conan-icon-size)",
    zIndex: 1,
  },
  tabActionFade: {
    backgroundImage: "linear-gradient(to right, transparent 0%, var(--conan-color-popover) 45%)",
    height: "100%",
    insetInlineEnd: 0,
    opacity: 0,
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    transitionDuration: "var(--conan-duration-fast)",
    transitionProperty: "opacity",
    width: "calc(var(--conan-space-6) + var(--conan-space-4))",
  },
  tabActionFadeSelected: {
    backgroundImage: "linear-gradient(to right, transparent 0%, var(--conan-wash-tab-selected) 45%), linear-gradient(to right, transparent 0%, var(--conan-color-popover) 45%)",
  },
  tabActionVisible: { opacity: 1 },
  optionsButton: {
    backgroundColor: {
      default: "transparent",
      ":hover": "transparent",
      ":active": "transparent",
    },
    borderRadius: "var(--conan-radius-xs)",
    color: "inherit",
    height: "var(--conan-icon-size)",
    opacity: 0,
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    width: "var(--conan-icon-size)",
  },
  dockSwitcher: {
    alignItems: "center",
    display: "flex",
    height: "var(--conan-control-height)",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: "var(--conan-duration-fast)",
    paddingInlineEnd: "var(--conan-space-1)",
  },
  switcherButton: {
    borderRadius: "var(--conan-radius-xs)",
    color: "inherit",
    height: "var(--conan-icon-size)",
    width: "var(--conan-icon-size)",
  },
  opener: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-strong)",
    height: "var(--conan-control-height)",
  },
  openerDim: { opacity: 0.2 },
  sectionLabel: {
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-2)",
  },
  badge: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-full)",
    minWidth: "var(--conan-icon-size)",
    paddingInline: "var(--conan-space-1)",
    textAlign: "center",
  },
  divider: {
    border: 0,
    borderTop: "var(--conan-border-width) solid var(--conan-color-border)",
    marginBlock: "var(--conan-space-1)",
    width: "100%",
  },
});

function PlacementMenuItem({
  placement,
  current,
  onSelect,
}: {
  placement: (typeof PLACEMENTS)[number];
  current: boolean;
  onSelect: () => void;
}) {
  const menu = useDropdownMenuContext();
  const PlacementIcon = placement.icon;

  return (
    <Item
      role="menuitemradio"
      aria-checked={current}
      tabIndex={-1}
      label={placement.label}
      startContent={<PlacementIcon size={ICON} aria-hidden />}
      endContent={current ? <Check size={ICON} aria-hidden /> : undefined}
      onClick={() => {
        onSelect();
        menu?.closeMenu();
      }}
    />
  );
}

function DockedSurfaceMenuItem({
  tab,
  current,
  onSelect,
}: {
  tab: SurfaceTab;
  current: boolean;
  onSelect: () => void;
}) {
  const menu = useDropdownMenuContext();
  const SurfaceIcon = tab.icon;

  return (
    <Item
      role="menuitemradio"
      aria-checked={current}
      tabIndex={-1}
      label={tab.label}
      startContent={<SurfaceIcon size={ICON} aria-hidden />}
      endContent={current ? <Check size={ICON} aria-hidden /> : undefined}
      onClick={() => {
        onSelect();
        menu?.closeMenu();
      }}
    />
  );
}

function SurfaceTabItem({
  tab,
  dockedTabs,
  onSelect,
  onClose,
  onPlacementChange,
}: {
  tab: SurfaceTab;
  dockedTabs: SurfaceTab[];
  onSelect?: SurfaceTabsProps["onSelect"];
  onClose?: SurfaceTabsProps["onClose"];
  onPlacementChange?: SurfaceTabsProps["onPlacementChange"];
}) {
  const {
    id,
    label,
    icon: Icon,
    isCloseable,
    isSelected,
    isDocked,
    joinedSide,
    dockedDescription,
  } = tab;
  const isVisuallyActive = tab.isVisuallyActive ?? (isSelected || isDocked);
  const [actionsVisible, setActionsVisible] = useState(false);
  const stopControlClick = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
  }, []);
  const surfaceId = id === "chat" ? null : id;
  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      if (!surfaceId) return;
      event.dataTransfer.setData(SURFACE_DRAG_MIME_TYPE, surfaceId);
      event.dataTransfer.effectAllowed = "move";
    },
    [surfaceId],
  );

  const tabNode = (
    <ToggleButton
      label={label}
      value={id}
      size="sm"
      xstyle={[
        styles.tab,
        isVisuallyActive && styles.tabSelected,
        joinedSide === "start" && styles.joinedStart,
        joinedSide === "end" && styles.joinedEnd,
      ]}
      aria-description={dockedDescription}
      draggable={surfaceId != null && !isDocked}
      onDragStart={handleDragStart}
      data-slot="surface-tab"
    >
      <HStack align="center" xstyle={styles.tabLabel} data-slot="surface-tab-label">
        <Icon size={ICON} aria-hidden />
        <Text
          color={isVisuallyActive ? "primary" : "secondary"}
          weight={isVisuallyActive ? "semibold" : "normal"}
        >
          {label}
        </Text>
        {tab.count != null ? (
          <Text color="inherit" type="supporting" xstyle={styles.badge}>
            {tab.count}
          </Text>
        ) : null}
      </HStack>
    </ToggleButton>
  );

  if (isDocked && surfaceId && dockedTabs.length > 1) {
    return (
      <HStack xstyle={styles.tabShell} data-slot="surface-tab-shell">
        {tabNode}
        <HStack
          xstyle={styles.tabActions}
          onClick={stopControlClick}
          data-slot="docked-surface-switcher"
        >
          <HStack xstyle={styles.dockSwitcher}>
            <DropdownMenu
              button={{
                label: "Switch docked surface",
                icon: <ChevronDown size={ICON} aria-hidden />,
                isIconOnly: true,
                variant: "ghost",
                size: "sm",
                xstyle: styles.switcherButton,
              }}
              hasChevron={false}
              placement="below"
            >
              {dockedTabs.map((candidate) => (
                <DockedSurfaceMenuItem
                  key={candidate.id}
                  tab={candidate}
                  current={candidate.id === id}
                  onSelect={() => onSelect?.(candidate.id)}
                />
              ))}
            </DropdownMenu>
          </HStack>
        </HStack>
      </HStack>
    );
  }

  if (!isCloseable || !surfaceId || isDocked) return tabNode;

  return (
    <HStack
      xstyle={styles.tabShell}
      data-slot="surface-tab-shell"
      onMouseEnter={() => setActionsVisible(true)}
      onMouseLeave={() => setActionsVisible(false)}
      onFocusCapture={() => setActionsVisible(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setActionsVisible(false);
        }
      }}
    >
      {tabNode}
      <HStack
        xstyle={styles.tabActions}
        data-slot="surface-tab-actions"
      >
        <HStack
          aria-hidden
          xstyle={[
            styles.tabActionFade,
            isVisuallyActive && styles.tabActionFadeSelected,
            actionsVisible && styles.tabActionVisible,
          ]}
          data-slot="surface-tab-action-fade"
        />
        <DropdownMenu
          button={{
            label: `${label} surface options`,
            icon: <MoreVertical size={ICON} aria-hidden />,
            isIconOnly: true,
            variant: "ghost",
            size: "sm",
            xstyle: [styles.optionsButton, actionsVisible && styles.tabActionVisible],
          }}
          hasChevron={false}
          placement="below"
          data-testid="surface-options-trigger"
        >
          <Text color="secondary" xstyle={styles.sectionLabel}>
            Dock &amp; Surface
          </Text>
          {PLACEMENTS.map((placement) => (
            <PlacementMenuItem
              key={placement.id}
              placement={placement}
              current={tab.placement === placement.id}
              onSelect={() => onPlacementChange?.(surfaceId, placement.id)}
            />
          ))}
          <hr {...stylex.props(styles.divider)} />
          <DropdownMenuItem
            label="Close Surface"
            icon={<X size={ICON} aria-hidden />}
            onClick={() => onClose?.(surfaceId)}
          />
        </DropdownMenu>
      </HStack>
    </HStack>
  );
}

export default function SurfaceTabs({
  tabs = DEFAULT_TABS,
  saganAvailable = false,
  onSelect,
  onOpen,
  onClose,
  onPlacementChange,
}: SurfaceTabsProps) {
  const openIds = new Set(tabs.map((tab) => tab.id));
  const availableOptions = SURFACE_OPTIONS.filter(
    (surface) => surface.id !== "sagan" || saganAvailable,
  );
  const allOpen = availableOptions.every((surface) => openIds.has(surface.id));
  const dockedTabs = tabs.filter((tab) => tab.id !== "chat" && tab.placement != null);
  const visibleTabs = tabs.filter((tab) => tab.placement == null || tab.isDocked);
  const selectedId = tabs.find((tab) => tab.isSelected)?.id ?? null;

  return (
    <HStack
      align="center"
      gap={0.5}
      xstyle={styles.strip}
      data-slot="surface-tabs"
    >
      <ToggleButtonGroup
        value={selectedId}
        onChange={(id) => {
          // Astryx single-select groups allow deselection. View navigation
          // always has an active mode, so clicking the current mode is a no-op.
          if (id) onSelect?.(id as SurfaceId);
        }}
        label="Chat and surfaces"
        size="sm"
        xstyle={styles.toggleGroup}
      >
        {visibleTabs.map((tab, index) => {
          if (tab.joinedSide === "end") return null;
          const joinedTab = tab.joinedSide === "start" ? visibleTabs[index + 1] : undefined;
          const item = (candidate: SurfaceTab) => (
            <SurfaceTabItem
              key={candidate.id}
              tab={candidate}
              dockedTabs={dockedTabs}
              onSelect={onSelect}
              onClose={onClose}
              onPlacementChange={onPlacementChange}
            />
          );
          if (!joinedTab || joinedTab.joinedSide !== "end") return item(tab);
          return (
            <HStack
              key="docked-tab-group"
              gap={0}
              xstyle={[
                styles.dockGroup,
                !tab.isVisuallyActive && styles.dockGroupInactive,
              ]}
              data-slot="docked-tab-group"
            >
              {item(tab)}
              {item(joinedTab)}
            </HStack>
          );
        })}
      </ToggleButtonGroup>
      <DropdownMenu
        button={{
          label: "Surface",
          icon: <Layers size={ICON} aria-hidden />,
          children: <Text color="inherit">Surface</Text>,
          variant: "ghost",
          size: "sm",
          isDisabled: allOpen,
          xstyle: [styles.opener, allOpen && styles.openerDim],
        }}
        items={availableOptions.map((surface) => ({
          label: surface.label,
          icon: <surface.icon size={ICON} aria-hidden />,
          onClick: () => onOpen?.(surface.id),
          isDisabled: openIds.has(surface.id),
        }))}
        data-slot="surface-opener"
      />
    </HStack>
  );
}
