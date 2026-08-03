/**
 * The context meter's denominator comes from the SESSION capabilities frame
 * only — never from the provider registry (WHA-102).
 *
 * Its own file because the registry mock is module-scoped: here the provider
 * row advertises a window, which the shipped registry never does. If someone
 * re-adds a registry fallback to `V2Composer`, this test fails.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import V2Composer from "../chat/V2Composer.tsx";
import type { ActiveThread } from "../lib/types.ts";

vi.mock("../lib/useV2Providers.ts", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../lib/useV2Providers.ts")
  >();
  return {
    ...original,
    useV2Providers: () => [
      {
        id: "claude",
        name: "Claude Code",
        installed: true,
        capabilities: {
          models: [],
          effortModes: [],
          permissionModes: [],
          // Deliberately NOT null, unlike every shipped driver descriptor.
          contextWindowTokens: 200_000,
        },
      },
    ],
  };
});

const thread: ActiveThread = {
  key: "meter",
  cwd: "/tmp/conan-wha-102",
  provider: "claude",
  title: "Context window source",
};

describe("context-meter denominator", () => {
  it("ignores a registry window and shows the raw count when no session caps have arrived", () => {
    render(
      <V2Composer activeThread={thread} send={vi.fn()} contextTokens={45_000} />,
    );
    const ring = screen.getByRole("img", { name: /Context window/ });
    // Registry says 200k. If it were consulted this would read "23% · 45k/200k".
    expect(ring).toHaveAttribute("aria-label", "Context window: 45k tokens");
    expect(ring).toHaveAttribute("data-pct", "unknown");
  });

  it("uses the session capabilities frame when it has arrived", () => {
    render(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        contextTokens={45_000}
        sessionCapabilities={{
          imageInput: false,
          streamingDeltas: true,
          interactiveApproval: true,
          livePermissionSwitch: true,
          costUsd: true,
          reasoningText: false,
          resume: true,
          contextWindowTokens: 1_000_000,
          modelSelection: true,
          models: [],
          permissionModes: [],
          effortModes: [],
        }}
      />,
    );
    const ring = screen.getByRole("img", { name: /Context window/ });
    expect(ring).toHaveAttribute("aria-label", "Context window: 5% · 45k/1M");
  });
});
