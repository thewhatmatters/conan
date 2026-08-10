/**
 * ChatSurfaceToolbar — Paper 2SJ-0 node HL-0, relocated.
 *
 * This row belongs to the Chat surface only: Actions (left), Open and
 * Commit & Push (right). It renders inside V2ChatView, not in the shell,
 * so Terminal/Browser/Diff/etc. surfaces appear full-pane without it.
 *
 * The menu triggers are real focusable buttons with menu ARIA. Menu panels
 * are still shell-level workflows; only the trigger row lives here.
 */
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
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
    borderBottomColor: "var(--conan-color-border)",
    borderBottomStyle: "solid",
    borderBottomWidth: "var(--conan-border-width)",
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
    width: "100%",
  },
  row: {
    height: "var(--conan-control-height)",
    minWidth: 0,
  },
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
      data-slot="chat-surface-toolbar-control"
    >
      <Icon size={ICON} aria-hidden />
      <Text color="secondary" weight={isPrimary ? "semibold" : "normal"}>
        {label}
      </Text>
      <ChevronDown size={ICON} aria-hidden />
    </button>
  );
}

export default function ChatSurfaceToolbar() {
  // Only one menu open at a time; shell stub — no panel yet, just the ARIA state.
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);

  const toggle = (id: MenuId) => {
    setOpenMenu((current) => (current === id ? null : id));
  };

  return (
    <HStack
      align="center"
      justify="between"
      gap={0.5}
      padding={4}
      xstyle={styles.bar}
      data-slot="chat-surface-toolbar"
    >
      <MenuControl
        id="actions"
        label="Actions"
        ariaLabel="Actions menu"
        icon={Zap}
        isPrimary
        isExpanded={openMenu === "actions"}
        onToggle={() => toggle("actions")}
      />
      <HStack gap={0.5} align="center" justify="end" xstyle={styles.row} data-slot="workflow-controls">
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
  );
}
