/**
 * V2Composer — minimal send (US-203).
 *
 * ChatComposerInput is contenteditable (role=textbox), not a native input —
 * mirror Astryx's own tests: set textContent + fireEvent.input/keyDown.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
          effortModes: [{ id: "think", label: "Think" }],
          permissionModes: [
            { id: "default", label: "Supervised", description: "Ask first" },
            { id: "plan", label: "Plan", description: "Plan first" },
          ],
        },
      },
    ],
  };
});

const thread: ActiveThread = {
  key: "analyze",
  cwd: "/tmp/conan-v2-p2a",
  provider: "claude",
  title: "Analyze my project",
};

function typeAndSubmit(text: string) {
  const textbox = screen.getByLabelText("Message input");
  textbox.textContent = text;
  fireEvent.input(textbox);
  fireEvent.keyDown(textbox, { key: "Enter" });
  return textbox;
}

describe("V2Composer", () => {
  it("renders ChatComposer with Ask anything placeholder", () => {
    const { container } = render(
      <V2Composer activeThread={thread} send={vi.fn()} />,
    );

    expect(container.querySelector('[data-slot="v2-composer"]')).not.toBeNull();
    expect(screen.getByText("Ask anything")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Message input"),
    ).toBeInTheDocument();
  });

  it("calls send(text, { cwd, provider }) on submit and clears the input", () => {
    const send = vi.fn();
    render(<V2Composer activeThread={thread} send={send} />);

    const textbox = typeAndSubmit("ping the agent");

    expect(send).toHaveBeenCalledWith(
      "ping the agent",
      {
        cwd: "/tmp/conan-v2-p2a",
        provider: "claude",
        projectId: undefined,
        permissionMode: undefined,
      },
      // p2c: staged pins/images ride the same send (empty with nothing staged).
      [],
      [],
    );
    expect(textbox.textContent).toBe("");
  });

  it("does not send when there is no active thread", () => {
    const send = vi.fn();
    render(<V2Composer activeThread={null} send={send} />);

    const textbox = screen.getByLabelText("Message input");
    // Disabled → contenteditable false; still attempt Enter for safety.
    expect(textbox).toHaveAttribute("contenteditable", "false");
    textbox.textContent = "nope";
    fireEvent.input(textbox);
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(send).not.toHaveBeenCalled();
  });

  it("does not send while busy", () => {
    const send = vi.fn();
    render(<V2Composer activeThread={thread} send={send} busy />);

    typeAndSubmit("wait");

    expect(send).not.toHaveBeenCalled();
  });

  it("locks provider/model after turn one while effort and permission stay interactive", () => {
    const { container } = render(
      <V2Composer activeThread={thread} send={vi.fn()} locked />,
    );

    expect(
      container.querySelector('[data-slot="model-picker-locked"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Default effort/ }),
    ).toBeEnabled();
    // WHA-97: permission chip stays mounted so mid-session switches show.
    expect(
      screen.getByRole("button", { name: "Supervised" }),
    ).toBeInTheDocument();
  });

  it("sends the provider-defined permission mode selected for a fresh session", () => {
    const send = vi.fn();
    render(<V2Composer activeThread={thread} send={send} />);

    fireEvent.click(screen.getByRole("button", { name: "Supervised" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan" }));
    typeAndSubmit("propose a plan");

    expect(send).toHaveBeenCalledWith(
      "propose a plan",
      expect.objectContaining({ permissionMode: "plan" }),
      [],
      [],
    );
  });

  it("pre-launch selection is local; mid-session selection rides setPermissionMode", () => {
    const setPermissionMode = vi.fn();
    const send = vi.fn();
    const { unmount } = render(
      <V2Composer
        activeThread={thread}
        send={send}
        sessionId={null}
        setPermissionMode={setPermissionMode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Supervised" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan" }));
    expect(setPermissionMode).not.toHaveBeenCalled();
    typeAndSubmit("propose a plan");
    expect(send).toHaveBeenCalledWith(
      "propose a plan",
      expect.objectContaining({ permissionMode: "plan" }),
      [],
      [],
    );
    unmount();

    // Session is live: chip follows livePermissionMode; switch rides socket.
    const { rerender } = render(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        sessionId="sess-1"
        livePermissionMode="plan"
        setPermissionMode={setPermissionMode}
      />,
    );
    expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Supervised" }));
    expect(setPermissionMode).toHaveBeenCalledWith("default");

    // Confirmed live mode event moves the chip off Plan (no optimistic update).
    rerender(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        sessionId="sess-1"
        livePermissionMode="default"
        setPermissionMode={setPermissionMode}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Supervised" }),
    ).toBeInTheDocument();
  });
});
