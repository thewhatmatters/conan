/**
 * ModelPicker (p2c US-303) — trigger drawn from S5-0's TY-0, open behaviour
 * ported from v1's ProviderModelPicker.
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
        effort=""
        onSelect={vi.fn()}
        onEffortSelect={vi.fn()}
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
        effort=""
        onSelect={vi.fn()}
        onEffortSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Claude · Default/ }),
    ).toBeInTheDocument();
  });

  it("appends effort only once chosen", () => {
    expect(pickerLabel(provider(), "Claude Code", "opus", "")).toBe(
      "Claude · Opus 5",
    );
    expect(pickerLabel(provider(), "Claude Code", "opus", "think")).toBe(
      "Claude · Opus 5 · Think",
    );
  });

  it("degrades to a static locked indicator, not a dead dropdown", () => {
    const { container } = render(
      <ModelPicker
        providers={[provider()]}
        activeProviderId="claude"
        model="opus"
        effort=""
        locked
        onSelect={vi.fn()}
        onEffortSelect={vi.fn()}
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
    const onEffortSelect = vi.fn();
    render(
      <ModelPicker
        providers={[provider(), codex]}
        activeProviderId="claude"
        model={undefined}
        effort=""
        onSelect={onSelect}
        onEffortSelect={onEffortSelect}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Claude ·/ }));
    return { onSelect, onEffortSelect };
  }

  it("commits a provider + model from the model row", () => {
    const { onSelect } = open();
    fireEvent.click(screen.getByText("Fable 5"));
    expect(onSelect).toHaveBeenCalledWith("claude", "fable");
  });

  it("browsing the rail does not commit — only the model row does", () => {
    const { onSelect } = open();
    fireEvent.click(
      screen.getByRole("button", { name: "Codex CLI" }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    // Codex exposes only a default → one honest commit row.
    const use = screen.getByRole("button", { name: "Use Codex CLI" });
    fireEvent.click(use);
    expect(onSelect).toHaveBeenCalledWith("codex", undefined);
  });

  it("commits an effort from the fly-out", () => {
    const { onEffortSelect } = open();
    fireEvent.click(screen.getByRole("button", { name: /Effort: Default/ }));
    fireEvent.click(screen.getByText("Think"));
    expect(onEffortSelect).toHaveBeenCalledWith("think");
  });

  it("filters the model list", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
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
