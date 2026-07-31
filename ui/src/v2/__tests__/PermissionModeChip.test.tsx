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
