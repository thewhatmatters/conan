/**
 * EffortChip — reasoning effort, as its OWN footer control.
 *
 * WHY IT IS SEPARATE FROM ModelPicker (the architectural point):
 *   - provider + model are the thread's IDENTITY. The gateway relaunches a
 *     resumed thread on its SAVED provider, so the launch config is fixed after
 *     turn 1 — ModelPicker locks.
 *   - effort is a PER-TURN parameter. Every turn is a fresh process (claude's
 *     think/ultrathink prompt prefix, codex's `-c model_reasoning_effort`,
 *     grok's `--reasoning-effort`), so it can change mid-thread and this chip
 *     NEVER locks.
 * v1 fused the two behind one trigger, which wrongly froze effort along with
 * the model. Splitting them is the fix.
 *
 * Capability-driven, never provider-name branching: the levels and their words
 * come from the active provider's `capabilities.effortModes`. A provider with
 * no effort levels renders NOTHING (absent, not a dead disabled chip).
 *
 * Copy must not imply this reveals thinking — reasoning TEXT stays redacted for
 * claude and encrypted for codex (docs D2).
 */
import * as stylex from "@stylexjs/stylex";
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";
import type { ProviderStatus } from "../../lib/useV2Providers.ts";

export interface EffortChipProps {
  /** Registry rows (`GET /api/agent/providers`). Empty until the fetch lands. */
  providers: ProviderStatus[];
  /** The provider driving this thread — whose effort vocabulary we show. */
  activeProviderId: string;
  /** Selected effort id, or "" for the provider's own default. */
  effort: string;
  onEffortSelect: (effort: string) => void;
}

const styles = stylex.create({
  // Matches the sibling model chip's geometry (32px pill). ChatComposer sets
  // `pointer-events: none` while disabled; effort stays reachable because it
  // applies to the NEXT turn, which is exactly when the composer is busy.
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

/** "" is the provider's own default — a real choice, so it leads the list. */
const DEFAULT_ID = "";

export default function EffortChip({
  providers,
  activeProviderId,
  effort,
  onEffortSelect,
}: EffortChipProps) {
  const active = providers.find((p) => p.id === activeProviderId);
  const effortModes = active?.capabilities.effortModes ?? [];

  // Absent, not disabled: a provider without effort levels has nothing to say.
  if (effortModes.length === 0) return null;

  const current = effortModes.find((e) => e.id === effort);
  const label = current?.label ?? "Default effort";

  return (
    <DropdownMenu
      button={{
        label,
        variant: "ghost",
        size: "md",
        xstyle: styles.trigger,
      }}
      data-slot="effort-chip"
    >
      <DropdownMenuRadioGroup
        value={effort}
        onChange={onEffortSelect}
        aria-label="Reasoning effort"
      >
        <DropdownMenuRadioItem
          value={DEFAULT_ID}
          label="Default effort"
          xstyle={[
            styles.menuItem,
            effort === DEFAULT_ID && styles.menuItemSelected,
          ]}
        />
        {effortModes.map((mode) => (
          <DropdownMenuRadioItem
            key={mode.id}
            value={mode.id}
            label={mode.label}
            xstyle={[
              styles.menuItem,
              effort === mode.id && styles.menuItemSelected,
            ]}
          />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
