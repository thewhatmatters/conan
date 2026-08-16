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
 *
 * Selection chrome (WHA-200): Astryx Selector — checkmark + aria-selected on
 * role=option. The 2px selected-bar (WHA-117) was correct to the ModelPicker
 * tokens and still unreadable on 32px plain-text rows; Randy rejected it.
 * Selector is a form control (required label, isLabelHidden for the compact
 * composer face), not a menu item — the whole chip is the Selector.
 */
import * as stylex from "@stylexjs/stylex";
import { Selector } from "@astryxdesign/core/Selector";
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
  // ChatComposer sets `pointer-events: none` while disabled; effort stays
  // reachable because it applies to the NEXT turn. minWidth:0 lets the flex
  // row compress at narrow width (labels ellipsize inside Selector).
  root: {
    minWidth: 0,
    pointerEvents: "auto",
  },
  trigger: {
    maxWidth: "100%",
    minWidth: 0,
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

  const options = [
    { value: DEFAULT_ID, label: "Default effort" },
    ...effortModes.map((mode) => ({ value: mode.id, label: mode.label })),
  ];

  return (
    <div data-slot="effort-chip" {...stylex.props(styles.root)}>
      <Selector
        label="Reasoning effort"
        isLabelHidden
        size="md"
        placement="above"
        options={options}
        value={effort}
        onChange={onEffortSelect}
        placeholder="Default effort"
        xstyle={styles.trigger}
      />
    </div>
  );
}
