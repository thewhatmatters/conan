/**
 * SecondaryBar — Paper RJ-0 node LN-0 (Actions · Open · Commit & Push).
 *
 * T0 STUB (owned by US-006). The three menu triggers are real focusable
 * buttons with menu ARIA (haspopup + expanded); menus themselves land in the
 * wiring pass. v1's `ThreadToolbar` holds the real behaviour.
 *
 * The bar is the FIRST thing inside the lifted content well (4N-0), not a
 * continuation of the toolbar above it — which is why it inherits the well's
 * tone and its 24px top-left round rather than drawing chrome of its own. Same
 * geometry as the toolbar: a 16px inset around one 32px control row.
 *
 * One asymmetry is deliberate, and it is the artboard's: "Actions" is semibold
 * where "Open" and "Commit & Push" are regular. Actions is the primary verb;
 * the other two are conveniences. Splitting them left/right says the same thing
 * a second way.
 */
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import {
  ChevronDown,
  FolderDown,
  GitCommitHorizontal,
  Zap,
  type LucideIcon,
} from "lucide-react";

const ICON = 16;

const styles = stylex.create({
  bar: {
    boxSizing: "border-box",
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
    width: "100%",
  },
  row: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
    width: "100%",
  },
  // Real <button> — reset UA chrome so the control still reads as RJ-0's
  // icon+label+chevron pill (32px tall, 10px radius, 12px inline pad).
  control: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: "transparent",
    borderRadius: "var(--conan-radius-md)",
    borderStyle: "none",
    borderWidth: 0,
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    font: "inherit",
    gap: "var(--conan-space-1)",
    height: "var(--conan-control-height)",
    justifyContent: "center",
    margin: 0,
    paddingBlock: 0,
    paddingInline: "var(--conan-space-3)",
  },
});

type MenuId = "actions" | "open" | "commit";

interface MenuControlProps {
  id: MenuId;
  label: string;
  /** Accessible name for the menu trigger (e.g. "Actions menu"). */
  ariaLabel: string;
  icon: LucideIcon;
  /** Semibold marks the bar's primary verb. Only "Actions" gets it on RJ-0. */
  isPrimary?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

function MenuControl({
  label,
  ariaLabel,
  icon: Icon,
  isPrimary = false,
  isExpanded,
  onToggle,
}: MenuControlProps) {
  return (
    <button
      type="button"
      {...stylex.props(styles.control)}
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={isExpanded}
      onClick={onToggle}
      data-slot="secondary-bar-control"
    >
      <Icon size={ICON} aria-hidden />
      <Text color="secondary" weight={isPrimary ? "semibold" : "normal"}>
        {label}
      </Text>
      <ChevronDown size={ICON} aria-hidden />
    </button>
  );
}

export default function SecondaryBar() {
  // Only one menu open at a time; shell stub — no panel yet, just the ARIA state.
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);

  const toggle = (id: MenuId) => {
    setOpenMenu((current) => (current === id ? null : id));
  };

  return (
    <VStack
      align="stretch"
      padding={4}
      xstyle={styles.bar}
      data-slot="secondary-bar"
    >
      <HStack gap={0.5} justify="between" align="center" xstyle={styles.row}>
        <MenuControl
          id="actions"
          label="Actions"
          ariaLabel="Actions menu"
          icon={Zap}
          isPrimary
          isExpanded={openMenu === "actions"}
          onToggle={() => toggle("actions")}
        />
        <HStack gap={0.5} align="center">
          <MenuControl
            id="open"
            label="Open"
            ariaLabel="Open menu"
            icon={FolderDown}
            isExpanded={openMenu === "open"}
            onToggle={() => toggle("open")}
          />
          <MenuControl
            id="commit"
            label="Commit & Push"
            ariaLabel="Commit and Push menu"
            icon={GitCommitHorizontal}
            isExpanded={openMenu === "commit"}
            onToggle={() => toggle("commit")}
          />
        </HStack>
      </HStack>
    </VStack>
  );
}
