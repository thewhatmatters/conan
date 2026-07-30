/**
 * SecondaryBar — Paper RJ-0 node LN-0 (Actions · Open · Commit & Push).
 *
 * T0 STUB (owned by US-006). Controls are static; v1's `ThreadToolbar` holds the
 * real behaviour for the wiring pass.
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
    flexShrink: 0,
    height: "var(--conan-secondary-bar-height)",
  },
  row: {
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
  control: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-icon-muted)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
});

interface MenuControlProps {
  label: string;
  icon: LucideIcon;
  /** Semibold marks the bar's primary verb. Only "Actions" gets it on RJ-0. */
  isPrimary?: boolean;
}

function MenuControl({ label, icon: Icon, isPrimary = false }: MenuControlProps) {
  return (
    <HStack
      align="center"
      hAlign="center"
      gap={1}
      paddingInline={3}
      xstyle={styles.control}
      aria-haspopup="menu"
      data-slot="secondary-bar-control"
    >
      <Icon size={ICON} aria-hidden />
      <Text color="secondary" weight={isPrimary ? "semibold" : "normal"}>
        {label}
      </Text>
      <ChevronDown size={ICON} aria-hidden />
    </HStack>
  );
}

export default function SecondaryBar() {
  return (
    <VStack
      align="stretch"
      padding={4}
      xstyle={styles.bar}
      data-slot="secondary-bar"
    >
      <HStack gap={0.5} justify="between" align="center" xstyle={styles.row}>
        <MenuControl label="Actions" icon={Zap} isPrimary />
        <HStack gap={0.5} align="center">
          <MenuControl label="Open" icon={FolderDown} />
          <MenuControl label="Commit & Push" icon={GitCommitHorizontal} />
        </HStack>
      </HStack>
    </VStack>
  );
}
