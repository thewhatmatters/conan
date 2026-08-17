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
          imageInput: true,
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
    expect(
      screen.getByRole("button", { name: "Attach files" }),
    ).toBeInTheDocument();
  });

  it("stages a selected image from the visible attachment action", async () => {
    const { container } = render(
      <V2Composer activeThread={thread} send={vi.fn()} />,
    );
    const chooser = container.querySelector<HTMLInputElement>('input[type="file"]');
    const image = new File(["image"], "reference.png", { type: "image/png" });

    expect(chooser).not.toBeNull();
    fireEvent.change(chooser!, { target: { files: [image] } });

    expect(await screen.findByText("Image 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Items" })).toBeInTheDocument();
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

  it("keeps a busy-turn follow-up as a draft until the turn finishes", () => {
    const send = vi.fn();
    const { container, rerender } = render(
      <V2Composer activeThread={thread} send={send} busy />,
    );

    const textbox = screen.getByLabelText("Message input");
    textbox.textContent = "follow up";
    fireEvent.input(textbox);
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(container.querySelector('[data-slot="rich-input"]')).toHaveAttribute(
      "data-submit-disabled",
      "true",
    );
    expect(send).not.toHaveBeenCalled();
    expect(textbox).toHaveTextContent("follow up");

    rerender(<V2Composer activeThread={thread} send={send} />);
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(send).toHaveBeenCalledWith(
      "follow up",
      expect.objectContaining({ cwd: thread.cwd, provider: "claude" }),
      [],
      [],
    );
    expect(textbox.textContent).toBe("");
  });

  it("locks provider/model after turn one while effort and permission stay interactive", () => {
    const { container } = render(
      <V2Composer activeThread={thread} send={vi.fn()} locked />,
    );

    expect(
      container.querySelector('[data-slot="model-picker-locked"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /Reasoning effort/i }),
    ).toBeEnabled();
    // WHA-97: permission chip stays mounted so mid-session switches show.
    expect(
      screen.getByRole("combobox", { name: /Permission mode/i }),
    ).toBeInTheDocument();
  });

  it("sends the provider-defined permission mode selected for a fresh session", () => {
    const send = vi.fn();
    render(<V2Composer activeThread={thread} send={send} />);

    fireEvent.click(screen.getByRole("combobox", { name: /Permission mode/i }));
    fireEvent.click(screen.getByRole("option", { name: "Plan" }));
    typeAndSubmit("propose a plan");

    expect(send).toHaveBeenCalledWith(
      "propose a plan",
      expect.objectContaining({ permissionMode: "plan" }),
      [],
      [],
    );
  });

  it("shows context progress only once usage is reported (WHA-101/119)", () => {
    const { rerender, container } = render(
      <V2Composer activeThread={thread} send={vi.fn()} contextTokens={null} />,
    );
    expect(container.querySelector('[data-slot="context-progress"]')).toBeNull();

    rerender(
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
          contextWindowTokens: 200_000,
          modelSelection: true,
          models: [],
          permissionModes: [],
          effortModes: [],
        }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Context" })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="context-progress"]')).toHaveAttribute(
      "data-pct",
      "23",
    );
  });

  it("explains auto-compaction and offers a fresh thread under context pressure", () => {
    const onStartNewThread = vi.fn();
    const { rerender } = render(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        contextTokens={150_000}
        sessionCapabilities={{
          imageInput: false,
          streamingDeltas: true,
          interactiveApproval: true,
          livePermissionSwitch: true,
          costUsd: true,
          reasoningText: false,
          resume: true,
          contextWindowTokens: 200_000,
          modelSelection: true,
          models: [],
          permissionModes: [],
          effortModes: [],
        }}
        onStartNewThread={onStartNewThread}
      />,
    );
    expect(screen.getByText(/Context is 75% full.*compact when needed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start new thread" }));
    expect(onStartNewThread).toHaveBeenCalledOnce();

    rerender(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        contextTokens={180_000}
        sessionCapabilities={{
          imageInput: false,
          streamingDeltas: true,
          interactiveApproval: true,
          livePermissionSwitch: true,
          costUsd: true,
          reasoningText: false,
          resume: true,
          contextWindowTokens: 200_000,
          modelSelection: true,
          models: [],
          permissionModes: [],
          effortModes: [],
        }}
        onStartNewThread={onStartNewThread}
      />,
    );
    expect(screen.getByText(/Context is 90% full/)).toBeInTheDocument();
  });

  it("shows measured compaction confirmation without presenting it as pressure", () => {
    render(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        contextCompactionMessage="Context compacted · 96% → 38%"
      />,
    );

    expect(screen.getByText("Context compacted · 96% → 38%")).toHaveAttribute(
      "data-slot",
      "context-compaction-confirmation",
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

    fireEvent.click(screen.getByRole("combobox", { name: /Permission mode/i }));
    fireEvent.click(screen.getByRole("option", { name: "Plan" }));
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
    expect(
      screen.getByRole("combobox", { name: /Permission mode/i }),
    ).toHaveTextContent("Plan");

    fireEvent.click(screen.getByRole("combobox", { name: /Permission mode/i }));
    fireEvent.click(screen.getByRole("option", { name: "Supervised" }));
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
      screen.getByRole("combobox", { name: /Permission mode/i }),
    ).toHaveTextContent("Supervised");
  });

  it("WHA-208: applies a frosted-glass backdrop so transcript text does not bleed through", () => {
    const { container } = render(
      <V2Composer activeThread={thread} send={vi.fn()} />,
    );
    // ChatComposer applies xstyle to an inner wrapper; the readable stylex class
    // is the only stable hook to that node in jsdom.
    const glass = container.querySelector(".V2Composer__styles\\.glass");
    expect(glass).not.toBeNull();

    // jsdom does not resolve CSS variables or compute backdrop-filter, but it
    // DOES report that a non-transparent background token is applied.
    const style = window.getComputedStyle(glass!);
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps the context pressure warning readable over the glass backdrop", () => {
    const { container } = render(
      <V2Composer
        activeThread={thread}
        send={vi.fn()}
        contextTokens={150_000}
        sessionCapabilities={{
          imageInput: false,
          streamingDeltas: true,
          interactiveApproval: true,
          livePermissionSwitch: true,
          costUsd: true,
          reasoningText: false,
          resume: true,
          contextWindowTokens: 200_000,
          modelSelection: true,
          models: [],
          permissionModes: [],
          effortModes: [],
        }}
      />,
    );

    const glass = container.querySelector(".V2Composer__styles\\.glass");
    const warning = screen.getByText(/Context is 75% full.*compact when needed/);
    expect(glass).not.toBeNull();
    expect(warning).toBeInTheDocument();

    const glassStyle = window.getComputedStyle(glass!);
    expect(glassStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    const warningStyle = window.getComputedStyle(warning);
    expect(warningStyle.color).not.toBe("rgba(0, 0, 0, 0)");
  });
});
