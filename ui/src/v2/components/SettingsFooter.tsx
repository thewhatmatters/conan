/**
 * SettingsFooter — Paper RJ-0 node 7W-0 (the Settings button in footer 7L-0).
 *
 * T0 STUB (owned by US-004). Static; US-004 hangs the real Settings menu off it.
 *
 * Scope note: this file is the BUTTON, not the footer band. The band (7L-0 — its
 * 16px inset and sidebar tone) belongs to `Sidebar.tsx`, so that this leaf and
 * `NewChatButton` stay independently ownable by parallel worktrees while the
 * chrome around them lives in the one composition file (contract §4.4).
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Settings } from "lucide-react";

const styles = stylex.create({
  // Measured off 7W-0. Icon and label share one colour declaration so they can
  // never drift apart — the icon inherits it via `currentColor`.
  button: {
    appearance: "none",
    backgroundColor: "transparent",
    borderStyle: "none",
    borderRadius: "var(--conan-radius-pill)",
    color: "var(--conan-icon-primary)",
    cursor: "pointer",
    flexShrink: 0,
    height: "var(--conan-control-height)",
    padding: 0,
  },
});

export default function SettingsFooter() {
  return (
    <button
      type="button"
      aria-label="Settings"
      {...stylex.props(styles.button)}
      data-slot="settings-footer"
    >
      <HStack align="center" gap={2} paddingBlock={2} paddingInline={3}>
        <Settings size={16} aria-hidden />
        <Text weight="medium" color="primary" maxLines={1}>
          Settings
        </Text>
      </HStack>
    </button>
  );
}
