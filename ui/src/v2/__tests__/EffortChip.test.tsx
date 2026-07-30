/**
 * EffortChip — effort as its own control.
 *
 * The load-bearing rule: effort is a PER-TURN parameter, so this chip stays
 * interactive even when the model picker is locked (turn 2+ / resumed thread).
 * Its vocabulary is capability-driven, never provider-name branching.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import EffortChip from "../chat/composer/EffortChip.tsx";
import type { ProviderStatus } from "../lib/useV2Providers.ts";

function provider(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: "claude",
    name: "Claude Code",
    avatarLetter: "C",
    binary: "claude",
    installed: true,
    version: "2.1.0",
    capabilities: {
      imageInput: true,
      streamingDeltas: true,
      interactiveApproval: true,
      livePermissionSwitch: true,
      costUsd: true,
      reasoningText: false,
      resume: true,
      contextWindowTokens: null,
      modelSelection: true,
      models: [],
      permissionModes: [],
      effortModes: [
        { id: "think", label: "Think", description: "Reason carefully" },
        { id: "ultrathink", label: "Ultrathink", description: "Deepest" },
      ],
    },
    ...over,
  } as ProviderStatus;
}

describe("EffortChip", () => {
  it("shows the provider's own effort vocabulary", () => {
    render(
      <EffortChip
        providers={[provider()]}
        activeProviderId="claude"
        effort="think"
        onEffortSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Think/ })).toBeInTheDocument();
  });

  it("reads 'Default effort' until a level is chosen", () => {
    render(
      <EffortChip
        providers={[provider()]}
        activeProviderId="claude"
        effort=""
        onEffortSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Default effort/ }),
    ).toBeInTheDocument();
  });

  it("commits a level", () => {
    const onEffortSelect = vi.fn();
    render(
      <EffortChip
        providers={[provider()]}
        activeProviderId="claude"
        effort=""
        onEffortSelect={onEffortSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Default effort/ }));
    fireEvent.click(screen.getByText("Ultrathink"));
    expect(onEffortSelect).toHaveBeenCalledWith("ultrathink");
  });

  it("is ABSENT — not a dead disabled chip — when the provider has no levels", () => {
    const { container } = render(
      <EffortChip
        providers={[
          provider({
            capabilities: { ...provider().capabilities, effortModes: [] },
          } as Partial<ProviderStatus>),
        ]}
        activeProviderId="claude"
        effort=""
        onEffortSelect={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
