import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("combobox", { name: /Permission mode/i }));
    fireEvent.click(screen.getByRole("option", { name: "Plan" }));
    expect(select).toHaveBeenCalledWith("plan");
  });

  it("marks the current permission mode with aria-selected (Selector check)", () => {
    render(
      <PermissionModeChip
        providers={[provider]}
        activeProviderId="claude"
        permissionMode="plan"
        onPermissionModeSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: /Permission mode/i }));

    const listbox = screen.getByRole("listbox");
    const selected = within(listbox).getByRole("option", { name: /Plan/ });
    expect(selected).toHaveAttribute("aria-selected", "true");

    const other = within(listbox).getByRole("option", { name: /Supervised/ });
    expect(other).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
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
