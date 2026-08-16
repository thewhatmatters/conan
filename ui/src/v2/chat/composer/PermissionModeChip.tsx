/**
 * PermissionModeChip — capability-driven launch mode for a fresh session.
 *
 * The provider owns the vocabulary. v2 only forwards the selected id through
 * AgentOpts, which lets Plan mode exercise the existing ExitPlanMode approval
 * channel without hard-coding Claude-specific choices here.
 *
 * Selection chrome (WHA-117): selected-bar + aria-current via SelectedBarMenuItem,
 * not DropdownMenuRadioItem (radio dots) — same language as EffortChip and
 * ModelPicker.
 */
import * as stylex from "@stylexjs/stylex";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import type { ProviderStatus } from "../../lib/useV2Providers.ts";
import SelectedBarMenuItem from "./SelectedBarMenuItem.tsx";

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
      {modes.map((mode) => (
        <SelectedBarMenuItem
          key={mode.id}
          label={mode.label}
          isSelected={current?.id === mode.id}
          onSelect={() => onPermissionModeSelect(mode.id)}
        />
      ))}
    </DropdownMenu>
  );
}
