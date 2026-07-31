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
});
