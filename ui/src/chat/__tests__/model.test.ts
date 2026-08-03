/**
 * Provider-union seam tests (WHA-100).
 *
 * Pins `asProviderId` narrowing (the kimi-class silent fallback) and set
 * equality between the UI `PROVIDER_IDS` map, the icon table, and the gateway
 * `PROVIDERS` registry — a missing entry on any side is a failing test.
 */
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../../../src/agent/registry.ts";
import { asProviderId, PROVIDER_IDS } from "../model.ts";
import { PROVIDER_ICON } from "../providerIcons.ts";

describe("asProviderId", () => {
  it.each([
    ["claude", "claude"],
    ["codex", "codex"],
    ["grok", "grok"],
    ["kimi", "kimi"],
    [null, "claude"],
    [undefined, "claude"],
    // Documented silent fallback: unknown / typo free-strings coalesce to claude
    // (same class of failure as pre-migration nulls; preferred over throwing).
    ["typo-provider", "claude"],
    ["Claude", "claude"],
    ["", "claude"],
  ] as const)("asProviderId(%j) → %j", (input, expected) => {
    expect(asProviderId(input)).toBe(expected);
  });
});

describe("provider set equality", () => {
  it("PROVIDER_IDS covers every registered ProviderId (and only those)", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(
      ["claude", "codex", "grok", "kimi"].sort(),
    );
  });

  it("PROVIDERS.map(p => p.id) ≡ PROVIDER_IDS", () => {
    const registryIds = PROVIDERS.map((p) => p.id).sort();
    const modelIds = [...PROVIDER_IDS].sort();
    expect(registryIds).toEqual(modelIds);
  });

  it("PROVIDER_ICON keys ≡ PROVIDER_IDS (compile-time Record + runtime pin)", () => {
    expect(Object.keys(PROVIDER_ICON).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});
