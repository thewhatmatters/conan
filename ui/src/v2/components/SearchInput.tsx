/**
 * SearchInput — Paper RJ-0 node MU-0 / RV-0 (the sidebar's ⌘K search field).
 *
 * The field is the command-palette OPENER (WHA-70 / US-401), not a separate
 * filter: click / Enter / Space opens the palette at App.v2. Implemented as a
 * real `<button>` so focus restoration after the palette closes cannot re-open
 * it (onFocus → close → restore focus → onFocus loop). Search typing happens
 * inside Astryx CommandPalette (VC-1). Geometry still comes from Paper
 * `get_jsx` on RV-0 via `tokens.css`.
 *
 * Astryx notes:
 *   - Layout is HStack/Text; the root is a native `<button>` because Astryx
 *     HStack's `as="button"` does not accept `type` on BaseProps, and a submit
 *     button would be wrong inside any future form. Geometry the props can't
 *     express (border, fixed chip box, button reset) rides stylex reading
 *     `--conan-*`.
 *   - The ⌘/K chips are built here rather than with Astryx's `Kbd`: `Kbd`
 *     renders one combined element, where RJ-0 draws two separate chips with a
 *     2px bottom edge.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Search } from "lucide-react";

const styles = stylex.create({
  // RV-0: the inset field. Colour is set here so the icon (currentColor) and
  // the `color="secondary"` Text agree without either hard-coding a value.
  // Button reset keeps browser defaults from fighting the artboard chrome.
  field: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "var(--conan-color-field)",
    borderColor: "var(--conan-color-border-strong)",
    borderStyle: "solid",
    borderWidth: "var(--conan-border-width)",
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "flex",
    flexGrow: 1,
    font: "inherit",
    gap: "var(--conan-space-2)",
    minWidth: 0,
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-2)",
    textAlign: "left",
    width: "100%",
  },
  // The label must yield to the chips, not push them out of the field.
  label: {
    flexGrow: 1,
    minWidth: 0,
  },
  // Placeholder label — same role as the former read-only input's placeholder.
  placeholder: {
    flexGrow: 1,
    minWidth: 0,
  },
  // A key cap: 20px tall, at least 20px wide, with the 2px bottom edge that
  // gives it its pressed-key read.
  chip: {
    backgroundColor: "var(--conan-wash-raised)",
    borderBottomColor: "var(--conan-color-border-strong)",
    borderBottomStyle: "solid",
    borderBottomWidth: "var(--conan-status-ring-width)",
    borderRadius: "var(--conan-radius-sm)",
    flexShrink: 0,
    height: "var(--conan-chip-size)",
    minWidth: "var(--conan-chip-size)",
  },
});

const ICON = 16;

function KeyCap({ children }: { children: string }) {
  return (
    <HStack
      align="center"
      hAlign="center"
      paddingInline={1}
      xstyle={styles.chip}
    >
      <Text type="supporting" weight="medium" color="secondary">
        {children}
      </Text>
    </HStack>
  );
}

export interface SearchInputProps {
  /** Opens the shell command palette (WHA-70). */
  onOpenPalette?: () => void;
}

export default function SearchInput({ onOpenPalette }: SearchInputProps) {
  return (
    <button
      type="button"
      aria-label="Search projects and threads"
      aria-haspopup="dialog"
      data-slot="search-input"
      onClick={onOpenPalette}
      {...stylex.props(styles.field)}
    >
      <HStack align="center" gap={1} xstyle={styles.label}>
        <Search size={ICON} aria-hidden />
        <Text type="body" color="secondary" xstyle={styles.placeholder}>
          Search
        </Text>
      </HStack>
      <HStack align="center" gap={1} aria-hidden>
        <KeyCap>⌘</KeyCap>
        <KeyCap>K</KeyCap>
      </HStack>
    </button>
  );
}
