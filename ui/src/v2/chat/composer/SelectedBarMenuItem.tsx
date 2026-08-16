/**
 * SelectedBarMenuItem — one selectable row in an Effort / Permission dropdown.
 *
 * Why this exists (WHA-117): both chips used DropdownMenuRadioItem, which paints
 * the radio-dot chrome Randy rejected. The selected language elsewhere in v2 is
 * ModelPicker's 2px accent bar (`styles.indicator`, tokens
 * `--conan-color-accent` + `--conan-indicator-height`) plus `aria-current`. A
 * bar alone is invisible to a screen reader, so the semantic has to ride along.
 *
 * Structural choice: stay inside DropdownMenu (not convert chips to Popover).
 * That keeps arrow / typeahead / Enter / Escape free. Rows are hand-built like
 * ModelPicker so both chips share one look and neither reintroduces radio dots.
 *
 * Must render as a child of DropdownMenu — closes via useDropdownMenuContext.
 */
import type { PointerEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { useDropdownMenuContext } from "@astryxdesign/core/DropdownMenu";
import { Text } from "@astryxdesign/core/Text";

export interface SelectedBarMenuItemProps {
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}

const styles = stylex.create({
  // Same shape as ModelPicker's model row: full-width relative button, hover
  // wash, selected wash. `:focus` wash is the Astryx menu language (menus drive
  // highlight via focus, including pointer-hover-focus).
  row: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":focus": "var(--conan-wash-hover)",
    },
    borderRadius: "var(--conan-radius-sm)",
    borderWidth: 0,
    boxSizing: "border-box",
    color: "var(--conan-text-primary)",
    cursor: "pointer",
    display: "block",
    fontFamily: "var(--conan-font-sans)",
    fontSize: "var(--conan-text-body)",
    outline: "none",
    paddingBlock: "var(--conan-space-1h)",
    paddingInline: "var(--conan-space-2)",
    position: "relative",
    textAlign: "start",
    width: "100%",
  },
  rowSelected: {
    backgroundColor: {
      default: "var(--conan-wash-hover)",
      ":hover": "var(--conan-wash-hover)",
      ":focus": "var(--conan-wash-hover)",
    },
  },
  // 16W-1 — the 2px selected bar, inset 4px, same language as ModelPicker /
  // the thread row. Do not invent a second underline.
  indicator: {
    backgroundColor: "var(--conan-color-accent)",
    borderRadius: "var(--conan-radius-full)",
    height: "var(--conan-indicator-height)",
    insetBlockEnd: 0,
    insetInlineEnd: "var(--conan-space-1)",
    insetInlineStart: "var(--conan-space-1)",
    position: "absolute",
  },
});

export default function SelectedBarMenuItem({
  label,
  isSelected,
  onSelect,
}: SelectedBarMenuItemProps) {
  const ctx = useDropdownMenuContext();

  const handlePointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    // Mirror Astryx focusMenuItemOnHover: mouse only, skip if already focused.
    if (e.pointerType !== "mouse") return;
    if (e.currentTarget !== e.currentTarget.ownerDocument.activeElement) {
      e.currentTarget.focus();
    }
  };

  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-current={isSelected ? "true" : undefined}
      data-selected={isSelected ? "true" : undefined}
      onClick={() => {
        onSelect();
        ctx?.closeMenu();
      }}
      onPointerMove={handlePointerMove}
      {...stylex.props(styles.row, isSelected && styles.rowSelected)}
    >
      <Text type="body" weight="medium" color="primary" maxLines={1}>
        {label}
      </Text>
      {isSelected ? (
        <span {...stylex.props(styles.indicator)} aria-hidden />
      ) : null}
    </button>
  );
}
