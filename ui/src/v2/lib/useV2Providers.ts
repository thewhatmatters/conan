/**
 * v2 provider-registry adapter (p2c US-303).
 *
 * Re-exports v1's `useProviders` — the shared, module-cached fetch of
 * `GET /api/agent/providers` (install probe + per-provider capability
 * descriptor). One fetch per app run is the point of that cache, so v2 rides
 * it rather than opening a second one.
 *
 * The registry is also the ONLY source for what a provider can do: models,
 * effort modes, install state. Nothing here branches on a provider NAME
 * (contract: capability-driven, docs §"chat architecture").
 */
import {
  useProviders,
  type AgentEffortMode,
  type ProviderStatus,
} from "../../hooks/useProviders.ts";
import type { AgentModel } from "../../../../src/agent/driver.ts";

export type { ProviderStatus, AgentEffortMode, AgentModel };

/** Registry rows, or `[]` until the shared fetch lands. */
export function useV2Providers(token: string | null): ProviderStatus[] {
  return useProviders(token);
}

/** Brand as the composer chip says it — the CLI product suffix ("Code", "CLI")
 *  is noise next to a model name, so "Claude Code" reads as "Claude". */
export function providerBrand(name: string): string {
  return name.replace(/\s+(Code|CLI)$/i, "");
}

/**
 * The trigger's label: `Brand · Model` (+ ` · Effort` once effort is chosen).
 * Model resolution order mirrors v1's chip — the registry entry's label (which
 * already carries the version, "Opus 5"), then the raw `-m` value from a
 * gateway too old to send `models`, then "Default".
 */
export function pickerLabel(
  provider: ProviderStatus | undefined,
  fallbackName: string,
  model: string | undefined,
  effort: string,
): string {
  const brand = providerBrand(provider?.name ?? fallbackName);
  const modelLabel = provider?.capabilities.models?.find(
    (m) => (m.value ?? undefined) === model,
  )?.label;
  const modelText =
    modelLabel && modelLabel !== "Default model"
      ? modelLabel
      : (model ?? "Default");
  const effortLabel = provider?.capabilities.effortModes?.find(
    (e) => e.id === effort,
  )?.label;
  return effortLabel
    ? `${brand} · ${modelText} · ${effortLabel}`
    : `${brand} · ${modelText}`;
}
