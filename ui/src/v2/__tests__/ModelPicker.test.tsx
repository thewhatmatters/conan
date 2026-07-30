/**
 * ModelPicker — trigger drawn from S5-0's TY-0, panel from artboard 122-1.
 *
 * Effort is NOT part of this control any more (it moved to EffortChip): the
 * provider+model pick is the thread's identity and locks after turn 1, while
 * effort is per-turn and must stay live. These tests hold that separation.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ModelPicker from "../chat/composer/ModelPicker.tsx";
import { pickerLabel } from "../lib/useV2Providers.ts";
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
      models: [
        { value: null, label: "Default model", description: "Opus 5" },
        { value: "opus", label: "Opus 5", description: "1M context" },
        { value: "fable", label: "Fable 5", description: "Most capable" },
      ],
      permissionModes: [],
      effortModes: [
        { id: "think", label: "Think", description: "Extra reasoning" },
      ],
    },
    ...over,
  } as ProviderStatus;
}

const codex = provider({
  id: "codex",
  name: "Codex CLI",
  avatarLetter: "X",
  binary: "codex",
  capabilities: {
    ...provider().capabilities,
    models: [{ value: null, label: "Default model" }],
    effortModes: [],
  },
} as Partial<ProviderStatus>);

describe("ModelPicker trigger", () => {
  it("reads Brand · Model with the version, per v1's chip", () => {
    render(
      <ModelPicker
        providers={[provider()]}
        activeProviderId="claude"
        model="fable"
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Claude · Fable 5/ }),
    ).toBeInTheDocument();
  });

  it("falls back to Default before a model is picked", () => {
    render(
      <ModelPicker
        providers={[provider()]}
        activeProviderId="claude"
        model={undefined}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Claude · Default/ }),
    ).toBeInTheDocument();
  });

  it("never shows effort in the trigger — that is EffortChip's job", () => {
    render(
      <ModelPicker
        providers={[provider()]}
        activeProviderId="claude"
        model="opus"
        onSelect={vi.fn()}
      />,
    );
    // The util still supports an effort segment (EffortChip owns that concern);
    // the model trigger must not render one.
    expect(pickerLabel(provider(), "Claude Code", "opus", "think")).toBe(
      "Claude · Opus 5 · Think",
    );
    expect(screen.queryByRole("button", { name: /Think/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Claude · Opus 5$/ }),
    ).toBeInTheDocument();
  });

  it("degrades to a static locked indicator, not a dead dropdown", () => {
    const { container } = render(
      <ModelPicker
        providers={[provider()]}
        activeProviderId="claude"
        model="opus"
        locked
        onSelect={vi.fn()}
      />,
    );
    expect(
      container.querySelector('[data-slot="model-picker-locked"]'),
    ).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ModelPicker panel", () => {
  function open(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
    const onSelect = vi.fn();
    render(
      <ModelPicker
        providers={[provider(), codex]}
        activeProviderId="claude"
        model={undefined}
        onSelect={onSelect}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude ·/ }));
    return { onSelect };
  }

  it("commits a provider + model from the model row", () => {
    const { onSelect } = open();
    fireEvent.click(screen.getByText("Fable 5"));
    expect(onSelect).toHaveBeenCalledWith("claude", "fable");
  });

  it("browsing the rail does not commit — only the model row does", () => {
    const { onSelect } = open();
    fireEvent.click(screen.getByRole("button", { name: "Codex CLI" }));
    expect(onSelect).not.toHaveBeenCalled();
    // Codex exposes only a default → one honest commit row.
    const use = screen.getByRole("button", { name: "Use Codex CLI" });
    fireEvent.click(use);
    expect(onSelect).toHaveBeenCalledWith("codex", undefined);
  });

  it("has no effort control in the panel", () => {
    open();
    expect(screen.queryByRole("button", { name: /Effort/ })).toBeNull();
  });

  it("filters the model list", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("Search…"), {
      target: { value: "fable" },
    });
    expect(screen.queryByText("Opus 5")).toBeNull();
    expect(screen.getByText("Fable 5")).toBeInTheDocument();
  });

  it("disables a provider that is not installed", () => {
    open({
      providers: [provider(), { ...codex, installed: false } as ProviderStatus],
    });
    expect(
      screen.getByRole("button", { name: /Codex CLI — not found on PATH/ }),
    ).toBeDisabled();
  });
});
