/**
 * SurfaceTabs — Paper RJ-0 nodes HL-0 (the tab strip) and its "Surface" entry.
 *
 * T0 STUB (owned by US-005). Static: no surface actually mounts, and the close
 * affordances are decoration for now — but they are PRESENT, because their
 * absence would change how the strip reads.
 *
 * RJ-0's grammar: Chat is the permanent tab and carries no close; Browser,
 * Terminal and Diff are the openable surfaces and each carries an ✕. Selection
 * is a translucent wash plus a jump in weight (400 → 600) and tone (muted →
 * primary, icon → white). Trailing the strip is the "Surface" opener, drawn at
 * 20% opacity — the artboard's way of saying "disabled until there is something
 * to open".
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import {
  ChevronDown,
  Diff,
  Globe,
  Layers,
  MessagesSquare,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";

/** The surfaces the shell can host, in the artboard's order. */
export interface SurfaceTab {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Chat is permanent; every other surface can be closed. */
  isCloseable?: boolean;
  isSelected?: boolean;
}

export interface SurfaceTabsProps {
  tabs?: SurfaceTab[];
}

const ICON = 16;

const styles = stylex.create({
  // Every tab is a 32px pill on the shell's workhorse 10px radius.
  tab: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-muted)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
  tabSelected: {
    backgroundColor: "var(--conan-wash-tab-selected)",
    color: "var(--conan-icon-strong)",
  },
  // The strip's own gutter is 2px — tighter than anything else in the shell, so
  // the tabs read as one segmented control rather than four buttons.
  strip: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
  // Not `disabled`: RJ-0 dims the whole opener to 20% rather than recolouring
  // its parts, which keeps the white icon/label relationship intact.
  opener: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-strong)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    opacity: 0.2,
  },
});

const DEFAULT_TABS: SurfaceTab[] = [
  { id: "chat", label: "Chat", icon: MessagesSquare, isSelected: true },
  { id: "browser", label: "Browser", icon: Globe, isCloseable: true },
  { id: "terminal", label: "Terminal", icon: Terminal, isCloseable: true },
  { id: "diff", label: "Diff", icon: Diff, isCloseable: true },
];

function Tab({ label, icon: Icon, isCloseable, isSelected }: SurfaceTab) {
  return (
    <HStack
      align="center"
      hAlign="center"
      gap={1}
      paddingInline={3}
      xstyle={[styles.tab, isSelected && styles.tabSelected]}
      role="tab"
      aria-selected={isSelected ?? false}
      data-slot="surface-tab"
    >
      <Icon size={ICON} aria-hidden />
      <Text
        color={isSelected ? "primary" : "secondary"}
        weight={isSelected ? "semibold" : "normal"}
      >
        {label}
      </Text>
      {isCloseable ? <X size={ICON} aria-label={`Close ${label}`} /> : null}
    </HStack>
  );
}

export default function SurfaceTabs({ tabs = DEFAULT_TABS }: SurfaceTabsProps) {
  return (
    <HStack
      align="center"
      gap={0.5}
      xstyle={styles.strip}
      role="tablist"
      aria-label="Surfaces"
      data-slot="surface-tabs"
    >
      {tabs.map((tab) => (
        <Tab key={tab.id} {...tab} />
      ))}
      <HStack
        align="center"
        hAlign="center"
        gap={1}
        paddingInline={3}
        xstyle={styles.opener}
      >
        <Layers size={ICON} aria-hidden />
        <Text color="inherit">Surface</Text>
        <ChevronDown size={ICON} aria-hidden />
      </HStack>
    </HStack>
  );
}
