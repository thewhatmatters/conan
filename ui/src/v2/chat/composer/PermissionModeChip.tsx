/**
 * PermissionModeChip — capability-driven launch mode for a fresh session.
 *
 * The provider owns the vocabulary. v2 only forwards the selected id through
 * AgentOpts, which lets Plan mode exercise the existing ExitPlanMode approval
 * channel without hard-coding Claude-specific choices here.
 *
 * Selection chrome (WHA-200): Astryx Selector — same as EffortChip. Checkmark +
 * aria-selected on role=option; whole chip is the form control (hidden label),
 * not a DropdownMenu with reinvented row chrome.
 */
import * as stylex from "@stylexjs/stylex";
import { Selector } from "@astryxdesign/core/Selector";
import type { ProviderStatus } from "../../lib/useV2Providers.ts";

export interface PermissionModeChipProps {
  providers: ProviderStatus[];
  activeProviderId: string;
  permissionMode: string;
  onPermissionModeSelect: (mode: string) => void;
}

const styles = stylex.create({
  root: {
    minWidth: 0,
    pointerEvents: "auto",
  },
  trigger: {
    maxWidth: "100%",
    minWidth: 0,
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
  const options = modes.map((mode) => ({ value: mode.id, label: mode.label }));

  return (
    <div data-slot="permission-mode-chip" {...stylex.props(styles.root)}>
      <Selector
        label="Permission mode"
        isLabelHidden
        size="md"
        placement="above"
        options={options}
        value={current?.id}
        onChange={onPermissionModeSelect}
        placeholder="Default permissions"
        xstyle={styles.trigger}
      />
    </div>
  );
}
