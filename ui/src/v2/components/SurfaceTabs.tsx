import { useCallback, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "./astryx/ToggleButton/index.ts";
import {
  Diff,
  FileText,
  Globe,
  Layers,
  MessagesSquare,
  Orbit,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";

export type SurfaceId = "chat" | "browser" | "terminal" | "diff" | "files" | "sagan";

export interface SurfaceTab {
  id: SurfaceId;
  label: string;
  icon: LucideIcon;
  isCloseable?: boolean;
  isSelected?: boolean;
  count?: number;
}

export interface SurfaceTabsProps {
  tabs?: SurfaceTab[];
  saganAvailable?: boolean;
  onSelect?: (id: SurfaceId) => void;
  onOpen?: (id: Exclude<SurfaceId, "chat">) => void;
  onClose?: (id: Exclude<SurfaceId, "chat">) => void;
}

export const SURFACE_OPTIONS: ReadonlyArray<
  Omit<SurfaceTab, "id" | "isSelected"> & {
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
    backgroundColor: {
      default: "transparent",
      ":hover": "transparent",
    },
    backgroundImage: "none",
    boxSizing: "border-box",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    outlineOffset: { default: "0", ":focus-visible": "2px" },
    width: "fit-content",
  },
  tabSelected: {
    backgroundColor: {
      default: "transparent",
      ":hover": "transparent",
    },
    backgroundImage: "none",
    color: "var(--conan-icon-strong)",
  },
  tabLabel: {
    columnGap: "var(--conan-space-2)",
    justifyContent: "center",
    position: "relative",
    top: "var(--conan-space-hair)",
    whiteSpace: "nowrap",
  },
  tabShell: {
    borderRadius: "var(--conan-radius-md)",
    flexShrink: 0,
    overflow: "hidden",
    position: "relative",
    backgroundColor: {
      default: null,
      ":hover": "var(--conan-wash-hover)",
    },
  },
  tabShellSelected: {
    // Flat backgroundColor intentionally replaces tabShell's :hover entry,
    // so the selected tab keeps only its selected wash and no extra hover state.
    backgroundColor: "var(--conan-wash-tab-selected)",
  },
  tabActions: {
    // A raised, bounded segment behind the ✕ so it reads as contained against
    // the strip and still darker than the label half of a selected/hovered tab.
    backgroundColor: "var(--conan-color-content)",
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    justifyContent: "center",
    overflow: "hidden",
    transition: {
      default: "width var(--conan-duration-fast) var(--conan-ease)",
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    width: 0,
  },
  tabActionsVisible: {
    width: "calc(var(--conan-icon-size) + var(--conan-space-1) * 2)",
  },
  tabActionVisible: { opacity: 1, pointerEvents: "auto" },
  closeButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderRadius: "var(--conan-radius-xs)",
    borderStyle: "none",
    color: "inherit",
    cursor: "pointer",
    display: "inline-flex",
    height: "var(--conan-icon-size)",
    justifyContent: "center",
    opacity: 0,
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    paddingInline: "var(--conan-space-1)",
    pointerEvents: "none",
  },
  opener: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-strong)",
    height: "var(--conan-control-height)",
  },
  openerDim: { opacity: 0.2 },
  badge: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-full)",
    minWidth: "var(--conan-icon-size)",
    paddingInline: "var(--conan-space-1)",
    textAlign: "center",
  },
});

function SurfaceTabItem({
  tab,
  onClose,
}: {
  tab: SurfaceTab;
  onClose?: SurfaceTabsProps["onClose"];
}) {
  const {
    id,
    label,
    icon: Icon,
    isCloseable,
    isSelected,
  } = tab;
  const [actionsVisible, setActionsVisible] = useState(false);
  const stopControlClick = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
  }, []);
  const surfaceId = id === "chat" ? null : id;

  const tabNode = (
    <ToggleButton
      label={label}
      value={id}
      size="sm"
      xstyle={[styles.tab, isSelected && styles.tabSelected]}
      data-slot="surface-tab"
    >
      <HStack align="center" xstyle={styles.tabLabel} data-slot="surface-tab-label">
        <Icon size={ICON} aria-hidden />
        <Text
          color={isSelected ? "primary" : "secondary"}
          weight={isSelected ? "semibold" : "normal"}
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

  return (
    <HStack
      align="center"
      xstyle={[styles.tabShell, isSelected && styles.tabShellSelected]}
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
      {isCloseable && surfaceId ? (
        <HStack
          align="center"
          justify="center"
          xstyle={[styles.tabActions, actionsVisible && styles.tabActionsVisible]}
          data-slot="surface-tab-actions"
        >
          <button
            type="button"
            aria-label={`Close ${label} tab`}
            title={`Close ${label} tab`}
            tabIndex={actionsVisible ? 0 : -1}
            onClick={(event) => {
              stopControlClick(event);
              onClose?.(surfaceId);
            }}
            {...stylex.props([styles.closeButton, actionsVisible && styles.tabActionVisible])}
            data-slot="surface-tab-close"
          >
            <X size={ICON} aria-hidden />
          </button>
        </HStack>
      ) : null}
    </HStack>
  );
}

export default function SurfaceTabs({
  tabs = DEFAULT_TABS,
  saganAvailable = false,
  onSelect,
  onOpen,
  onClose,
}: SurfaceTabsProps) {
  const openIds = new Set(tabs.map((tab) => tab.id));
  const availableOptions = SURFACE_OPTIONS.filter(
    (surface) => surface.id !== "sagan" || saganAvailable,
  );
  const allOpen = availableOptions.every((surface) => openIds.has(surface.id));
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
        {tabs.map((tab) => (
          <SurfaceTabItem
            key={tab.id}
            tab={tab}
            onClose={onClose}
          />
        ))}
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
