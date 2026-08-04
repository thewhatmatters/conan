/**
 * SearchInput — Paper RJ-0 node MU-0 / RV-0 (the sidebar's ⌘K search field).
 *
 * The field is the command-palette OPENER (WHA-70 / US-401), not a separate
 * filter: click or focus opens the palette at App.v2. Local typing is read-only
 * on purpose — search happens inside Astryx CommandPalette (VC-1). Geometry
 * still comes from Paper `get_jsx` on RV-0 via `tokens.css`.
 *
 * Astryx notes:
 *   - Structure is HStack/Text only; nothing raw. Geometry the props can't
 *     express (border, fixed chip box) rides `xstyle` reading `--conan-*`.
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
  field: {
    backgroundColor: "var(--conan-color-field)",
    borderColor: "var(--conan-color-border-strong)",
    borderStyle: "solid",
    borderWidth: "var(--conan-border-width)",
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-muted)",
    flexGrow: 1,
    minWidth: 0,
  },
  input: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: "var(--conan-text-primary)",
    flexGrow: 1,
    fontFamily: "var(--conan-font-sans)",
    fontSize: "var(--conan-text-body)",
    lineHeight: "var(--conan-leading-body)",
    minWidth: 0,
    padding: 0,
    "::placeholder": {
      color: "var(--conan-text-muted)",
      opacity: 1,
    },
    "::-webkit-search-cancel-button": {
      display: "none",
    },
  },
  // The label must yield to the chips, not push them out of the field.
  label: {
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
    <HStack
      align="center"
      gap={2}
      paddingBlock={1}
      paddingInline={2}
      xstyle={styles.field}
      data-slot="search-input"
      onClick={onOpenPalette}
    >
      <HStack align="center" gap={1} xstyle={styles.label}>
        <Search size={ICON} aria-hidden />
        <input
          type="search"
          aria-label="Search projects and threads"
          placeholder="Search"
          readOnly={Boolean(onOpenPalette)}
          onFocus={onOpenPalette}
          {...stylex.props(styles.input)}
        />
      </HStack>
      <HStack align="center" gap={1} aria-hidden>
        <KeyCap>⌘</KeyCap>
        <KeyCap>K</KeyCap>
      </HStack>
    </HStack>
  );
}
