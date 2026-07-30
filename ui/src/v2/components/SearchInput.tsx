/**
 * SearchInput — Paper RJ-0 node MU-0 / RV-0 (the sidebar's ⌘K search field).
 *
 * T0 STUB (owned by US-002). Static, non-interactive: it draws the field at the
 * artboard's measurements so the shell reads correctly, and US-002 replaces the
 * body with a real input + palette trigger. Every value here came out of Paper
 * via `get_jsx` on RV-0 — see `tokens.css` for the mapping.
 *
 * Astryx notes:
 *   - Structure is HStack/Text only; nothing raw. Geometry the props can't
 *     express (border, fixed chip box) rides `xstyle` reading `--conan-*`.
 *   - The ⌘/K chips are built here rather than with Astryx's `Kbd`: `Kbd`
 *     renders one combined element, where RJ-0 draws two separate chips with a
 *     2px bottom edge. US-002 can revisit if `Kbd` gains a per-key variant.
 *   - Each stub carries its own `stylex.create` on purpose. A shared
 *     "shell control" primitive would be nicer code but would put five
 *     parallel worktrees (US-002…US-006) on one file; duplication is the
 *     cheaper trade here (contract §4.4).
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

export default function SearchInput() {
  return (
    <HStack
      align="center"
      gap={2}
      paddingBlock={1}
      paddingInline={2}
      xstyle={styles.field}
      data-slot="search-input"
    >
      <HStack align="center" gap={1} xstyle={styles.label}>
        <Search size={ICON} aria-hidden />
        <Text color="secondary" xstyle={styles.label} maxLines={1}>
          Search
        </Text>
      </HStack>
      <HStack align="center" gap={1}>
        <KeyCap>⌘</KeyCap>
        <KeyCap>K</KeyCap>
      </HStack>
    </HStack>
  );
}
