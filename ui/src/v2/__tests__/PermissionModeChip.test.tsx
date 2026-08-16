import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PermissionModeChip from "../chat/composer/PermissionModeChip.tsx";
import type { ProviderStatus } from "../lib/useV2Providers.ts";

const provider = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  capabilities: {
    permissionModes: [
      { id: "default", label: "Supervised", description: "Ask first" },
      { id: "plan", label: "Plan", description: "Plan first" },
    ],
  },
} as ProviderStatus;

describe("PermissionModeChip", () => {
  it("renders only provider-defined modes and commits their ids", () => {
    const select = vi.fn();
    render(
      <PermissionModeChip
        providers={[provider]}
        activeProviderId="claude"
        permissionMode=""
        onPermissionModeSelect={select}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Supervised" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan" }));
    expect(select).toHaveBeenCalledWith("plan");
  });

  it("marks the current permission mode with aria-current + selected bar (no radio)", () => {
    render(
      <PermissionModeChip
        providers={[provider]}
        activeProviderId="claude"
        permissionMode="plan"
        onPermissionModeSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    // WHA-117: same selected-bar language as EffortChip / ModelPicker.
    const selected = screen.getByRole("menuitem", { name: "Plan" });
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(selected.querySelector("[aria-hidden]")).not.toBeNull();

    const other = screen.getByRole("menuitem", { name: "Supervised" });
    expect(other).not.toHaveAttribute("aria-current");
    expect(other).not.toHaveAttribute("data-selected");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("is absent when the provider exposes no permission vocabulary", () => {
    const { container } = render(
      <PermissionModeChip
        providers={[
          {
            ...provider,
            capabilities: { ...provider.capabilities, permissionModes: [] },
          },
        ]}
        activeProviderId="claude"
        permissionMode=""
        onPermissionModeSelect={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
