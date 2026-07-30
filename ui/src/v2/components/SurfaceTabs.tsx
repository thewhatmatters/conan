/**
 * SurfaceTabs — Paper RJ-0 nodes HL-0 (the tab strip) and its "Surface" entry.
 *
 * RJ-0's grammar: Chat is the permanent tab and carries no close; Browser,
 * Terminal and Diff are the openable surfaces and each carries an ✕. Selection
 * is a translucent wash plus a jump in weight (400 → 600) and tone (muted →
 * primary, icon → white). Trailing the strip is the "Surface" opener, drawn at
 * 20% opacity — the artboard's way of saying "disabled until there is something
 * to open".
 *
 * A11Y (US-101). The strip is a real WAI-ARIA tab strip: `role="tablist"` around
 * `role="tab"` items, one Tab stop for the whole group (roving tabindex), and
 * Arrow/Home/End moving between tabs. `onSelect`/`onClose` are optional — the
 * strip stays presentation-driven off `tabs` (mounting surfaces is US-005's job)
 * but the elements are genuine controls either way.
 *
 * WHY NOT Astryx's `TabList`/`Tab`. They exist (`npx astryx component TabList`)
 * and they are the right thing for *navigation* tabs, but they are the wrong
 * shape here on two counts:
 *   1. `TabList` renders a `<nav>` and `Tab` marks the active item with
 *      `aria-current="page"` — the navigation pattern, not `tablist`/`tab` with
 *      `aria-selected`, which is what this strip is (it switches surfaces inside
 *      one view; it does not navigate).
 *   2. `Tab` renders a `<button>`, and a closeable tab has to contain its own ✕
 *      button. Nesting a button inside a button is invalid HTML and breaks the
 *      inner control, so the tab element itself must NOT be a button.
 * What Astryx *does* own here is the keyboard behaviour: `useListFocus` — the
 * exact hook `TabList` itself uses — supplies the roving tabindex and the
 * Arrow/Home/End handling, so none of that is hand-rolled. `orientation: 'both'`
 * matches `TabList`: the APG lets a horizontal tab strip accept both axes.
 *
 * The ✕ is an Astryx `IconButton` sized down to the artboard's bare 16px glyph
 * (RJ-0 draws no chrome around it) and named "Close <label> tab".
 */
import {
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { useListFocus } from "@astryxdesign/core/hooks";
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
  /** Fired by click, Enter or Space on a tab. */
  onSelect?: (id: string) => void;
  /** Fired by the tab's ✕. */
  onClose?: (id: string) => void;
}

const ICON = 16;

const styles = stylex.create({
  // Every tab is a 32px pill on the shell's workhorse 10px radius.
  tab: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    // The focus ring is the shell's accent, matching every Astryx control.
    outline: {
      default: null,
      ":focus-visible": "2px solid var(--conan-color-accent)",
    },
    outlineOffset: {
      default: "0",
      ":focus-visible": "2px",
    },
  },
  tabSelected: {
    backgroundColor: "var(--conan-wash-tab-selected)",
    color: "var(--conan-icon-strong)",
  },
  // RJ-0 draws the ✕ as a bare 16px glyph, so the IconButton is shrunk to the
  // glyph's own box: same geometry as a plain icon, but a real named button
  // with a hover wash and a focus ring. `inherit` keeps it tracking the tab's
  // tone (muted → white on the selected tab) instead of the button's own.
  close: {
    borderRadius: "var(--conan-radius-xs)",
    color: "inherit",
    height: "var(--conan-icon-size)",
    width: "var(--conan-icon-size)",
  },
  // The strip's own gutter is 2px — tighter than anything else in the shell, so
  // the tabs read as one segmented control rather than four buttons.
  strip: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
  // Not `disabled`: RJ-0 dims the whole opener to 20% rather than recolouring
  // its parts, which keeps the white icon/label relationship intact. It carries
  // `role="button"` + `aria-disabled` so assistive tech hears what a sighted
  // user sees — an unavailable control — and, like a disabled <button>, it is
  // deliberately not focusable and has no click behaviour.
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

interface TabProps {
  tab: SurfaceTab;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
}

function Tab({ tab, onSelect, onClose }: TabProps) {
  const { id, label, icon: Icon, isCloseable, isSelected } = tab;

  const handleSelect = useCallback(() => onSelect?.(id), [onSelect, id]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // Only the tab's own keys activate it: Enter on the ✕ bubbles up here,
      // and closing a surface must not also select it.
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect?.(id);
    },
    [onSelect, id],
  );

  const handleClose = useCallback(
    (event: ReactMouseEvent) => {
      event.stopPropagation();
      onClose?.(id);
    },
    [onClose, id],
  );

  return (
    <HStack
      align="center"
      hAlign="center"
      gap={1}
      paddingInline={3}
      xstyle={[styles.tab, isSelected && styles.tabSelected]}
      role="tab"
      aria-selected={isSelected ?? false}
      // Roving tabindex: the strip is ONE Tab stop and the selected tab is the
      // tabbable one. `useListFocus` below repairs and moves this as focus
      // travels, so this is only the initial source of truth.
      tabIndex={isSelected ? 0 : -1}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      data-slot="surface-tab"
    >
      <Icon size={ICON} aria-hidden />
      <Text
        color={isSelected ? "primary" : "secondary"}
        weight={isSelected ? "semibold" : "normal"}
      >
        {label}
      </Text>
      {isCloseable ? (
        <IconButton
          label={`Close ${label} tab`}
          icon={<X size={ICON} aria-hidden />}
          variant="ghost"
          size="sm"
          xstyle={styles.close}
          onClick={handleClose}
          data-slot="surface-tab-close"
        />
      ) : null}
    </HStack>
  );
}

export default function SurfaceTabs({
  tabs = DEFAULT_TABS,
  onSelect,
  onClose,
}: SurfaceTabsProps) {
  // Astryx's own tab-strip keyboard engine (the hook `TabList` uses): Arrow /
  // Home / End move between `role="tab"` items, and the single roving tab stop
  // is stamped and repaired as tabs mount, unmount or change selection.
  const { listRef, handleKeyDown, handleFocus } = useListFocus<HTMLElement>({
    itemSelector: '[role="tab"]',
    orientation: "both",
    hasRovingTabIndex: true,
  });

  return (
    <HStack
      ref={listRef}
      align="center"
      gap={0.5}
      xstyle={styles.strip}
      role="tablist"
      aria-label="Surfaces"
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      data-slot="surface-tabs"
    >
      {tabs.map((tab) => (
        <Tab key={tab.id} tab={tab} onSelect={onSelect} onClose={onClose} />
      ))}
      <HStack
        align="center"
        hAlign="center"
        gap={1}
        paddingInline={3}
        xstyle={styles.opener}
        role="button"
        aria-disabled="true"
        data-slot="surface-opener"
      >
        <Layers size={ICON} aria-hidden />
        <Text color="inherit">Surface</Text>
        <ChevronDown size={ICON} aria-hidden />
      </HStack>
    </HStack>
  );
}
