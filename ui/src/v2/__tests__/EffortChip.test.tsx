/**
 * EffortChip — effort as its own control.
 *
 * The load-bearing rule: effort is a PER-TURN parameter, so this chip stays
 * interactive even when the model picker is locked (turn 2+ / resumed thread).
 * Its vocabulary is capability-driven, never provider-name branching.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(
      screen.getByRole("combobox", { name: /Reasoning effort/i }),
    ).toHaveTextContent("Think");
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
      screen.getByRole("combobox", { name: /Reasoning effort/i }),
    ).toHaveTextContent("Default effort");
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
    fireEvent.click(screen.getByRole("combobox", { name: /Reasoning effort/i }));
    fireEvent.click(screen.getByRole("option", { name: "Ultrathink" }));
    expect(onEffortSelect).toHaveBeenCalledWith("ultrathink");
  });

  it("marks the current effort with aria-selected + check (Selector, not radio/bar)", () => {
    render(
      <EffortChip
        providers={[provider()]}
        activeProviderId="claude"
        effort="think"
        onEffortSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: /Reasoning effort/i }));

    const listbox = screen.getByRole("listbox");
    const selected = within(listbox).getByRole("option", { name: /Think/ });
    expect(selected).toHaveAttribute("aria-selected", "true");

    const other = within(listbox).getByRole("option", { name: /Ultrathink/ });
    expect(other).toHaveAttribute("aria-selected", "false");

    // No menu-radio / selected-bar residue.
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("follows the ACTIVE provider's vocabulary, not a shared list", () => {
    const codex = provider({
      id: "codex",
      name: "Codex CLI",
      capabilities: {
        ...provider().capabilities,
        effortModes: [
          { id: "high", label: "High", description: "Codex's own word" },
        ],
      },
    } as Partial<ProviderStatus>);
    render(
      <EffortChip
        providers={[provider(), codex]}
        activeProviderId="codex"
        effort="high"
        onEffortSelect={vi.fn()}
      />,
    );
    // Codex's level, NOT Claude's Think/Ultrathink — capability-driven.
    expect(
      screen.getByRole("combobox", { name: /Reasoning effort/i }),
    ).toHaveTextContent("High");
    expect(screen.queryByText("Ultrathink")).toBeNull();
  });

  it("has no locked concept — effort is per-turn, so it can never freeze", () => {
    // The architectural rule, enforced structurally: EffortChip takes no
    // `locked` prop, so a locked thread (model fixed) still changes effort.
    const onEffortSelect = vi.fn();
    render(
      <EffortChip
        providers={[provider()]}
        activeProviderId="claude"
        effort=""
        onEffortSelect={onEffortSelect}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: /Reasoning effort/i });
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Think" }));
    expect(onEffortSelect).toHaveBeenCalledWith("think");
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
