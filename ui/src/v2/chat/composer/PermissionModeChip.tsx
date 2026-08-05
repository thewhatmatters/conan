/**
 * PermissionModeChip — capability-driven launch mode for a fresh session.
 *
 * The provider owns the vocabulary. v2 only forwards the selected id through
 * AgentOpts, which lets Plan mode exercise the existing ExitPlanMode approval
 * channel without hard-coding Claude-specific choices here.
 */
import * as stylex from "@stylexjs/stylex";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import type { ProviderStatus } from "../../lib/useV2Providers.ts";

export interface PermissionModeChipProps {
  providers: ProviderStatus[];
  activeProviderId: string;
  permissionMode: string;
  onPermissionModeSelect: (mode: string) => void;
}

const styles = stylex.create({
  trigger: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
    },
    borderRadius: "var(--conan-radius-pill)",
    height: "var(--conan-control-height)",
    pointerEvents: "auto",
  },
  menuItem: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":focus": "var(--conan-wash-hover)",
    },
  },
  menuItemSelected: {
    backgroundColor: {
      default: "var(--conan-wash-row-selected)",
      ":hover": "var(--conan-wash-row-selected)",
      ":focus": "var(--conan-wash-row-selected)",
    },
  },
});

export default function PermissionModeChip({
  providers,
  activeProviderId,
  permissionMode,
  onPermissionModeSelect,
}: PermissionModeChipProps) {
  const active = providers.find((provider) => provider.id === activeProviderId);
  const modes = active?.capabilities.permissionModes ?? [];
  if (modes.length === 0) return null;

  const fallback = modes.find((mode) => mode.id === "default") ?? modes[0];
  const current = modes.find((mode) => mode.id === permissionMode) ?? fallback;

  return (
    <DropdownMenu
      button={{
        label: current?.label ?? "Default permissions",
        variant: "ghost",
        size: "md",
        xstyle: styles.trigger,
      }}
      placement="above"
      data-slot="permission-mode-chip"
    >
      <DropdownMenuRadioGroup
        value={current?.id}
        onChange={onPermissionModeSelect}
        aria-label="Permission mode"
      >
        {modes.map((mode) => (
          <DropdownMenuRadioItem
            key={mode.id}
            value={mode.id}
            label={mode.label}
            xstyle={[
              styles.menuItem,
              current?.id === mode.id && styles.menuItemSelected,
            ]}
          />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
