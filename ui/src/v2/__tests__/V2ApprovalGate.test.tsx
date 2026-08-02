/**
 * V2ApprovalGate — the guided-input gate (WHA-86).
 *
 * The decision mapping moved here from V2ApprovalPanel's suite when the action
 * row moved. What is new and worth pinning:
 *
 *  - the option SET differs for a plan (no "always allow" — a plan is approved
 *    once, there is no tool kind to remember);
 *  - a guidance-bearing decision pairs the typed composer text with the
 *    decline, and the `permission-response` frame carries no text, so the
 *    guidance rides the FOLLOWING turn — order matters and is asserted;
 *  - Escape is inert on purpose. The agent is blocked; a dismissable gate
 *    would strand the turn with nothing on screen explaining why.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import V2ApprovalGate, { optionsFor } from "../chat/V2ApprovalGate.tsx";
import type { PendingApproval } from "../lib/useV2Chat.ts";

const approval: PendingApproval = {
  id: "approval-1",
  toolKind: "command",
  toolName: "Bash",
  toolUseId: "tool-1",
  summary: "Run the test suite",
  detail: "npm test",
  input: { command: "npm test" },
};

const plan: PendingApproval = {
  ...approval,
  toolKind: "other",
  toolName: "ExitPlanMode",
  detail: "# Approach\n\n- Step one",
};

describe("optionsFor", () => {
  it("offers all four decisions for a tool call", () => {
    expect(optionsFor(approval).map((o) => o.decision)).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
  });

  it("drops 'always allow' for a plan — there is no tool kind to remember", () => {
    const decisions = optionsFor(plan).map((o) => o.decision);
    expect(decisions).toEqual(["accept", "decline", "cancel"]);
  });

  it("keys options from A without gaps in either shape", () => {
    expect(optionsFor(approval).map((o) => o.key)).toEqual(["A", "B", "C", "D"]);
    expect(optionsFor(plan).map((o) => o.key)).toEqual(["A", "B", "C"]);
  });

  it("marks exactly one option as guidance-bearing", () => {
    for (const set of [optionsFor(approval), optionsFor(plan)]) {
      expect(set.filter((o) => o.sendsGuidance)).toHaveLength(1);
      expect(set.find((o) => o.sendsGuidance)?.decision).toBe("decline");
    }
  });
});

describe("V2ApprovalGate", () => {
  it("maps every option to its driver decision", () => {
    const respond = vi.fn();
    render(<V2ApprovalGate approval={approval} count={2} respond={respond} />);

    for (const [label, decision] of [
      ["Approve once", "accept"],
      ["Always allow this session", "acceptForSession"],
      ["Decline — tell it what to do instead", "decline"],
      ["Cancel turn", "cancel"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(respond).toHaveBeenLastCalledWith("approval-1", decision);
    }
  });

  it("renders the approval content inside the gate", () => {
    const { container } = render(
      <V2ApprovalGate approval={approval} count={1} respond={vi.fn()} />,
    );

    const gate = container.querySelector('[data-slot="v2-approval-gate"]');
    const content = container.querySelector('[data-slot="v2-approval-content"]');
    expect(gate).not.toBeNull();
    expect(gate?.contains(content!)).toBe(true);
  });

  it("moves focus into the options when it appears", () => {
    render(<V2ApprovalGate approval={approval} count={1} respond={vi.fn()} />);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Approve once" }),
    );
  });

  it("sends the typed guidance AFTER resolving the block, not before", () => {
    const calls: string[] = [];
    const respond = vi.fn(() => void calls.push("respond"));
    const sendGuidance = vi.fn(() => void calls.push("send"));
    render(
      <V2ApprovalGate
        approval={approval}
        count={1}
        respond={respond}
        sendGuidance={sendGuidance}
        guidance="use the other file"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Decline — tell it what to do instead" }),
    );

    expect(respond).toHaveBeenCalledWith("approval-1", "decline");
    expect(sendGuidance).toHaveBeenCalledWith("use the other file");
    // Sending first would queue a message behind a driver still waiting on us.
    expect(calls).toEqual(["respond", "send"]);
  });

  it("does not send guidance for a non-guidance decision", () => {
    const sendGuidance = vi.fn();
    render(
      <V2ApprovalGate
        approval={approval}
        count={1}
        respond={vi.fn()}
        sendGuidance={sendGuidance}
        guidance="typed but not meant as a denial reason"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(sendGuidance).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only guidance", () => {
    const sendGuidance = vi.fn();
    render(
      <V2ApprovalGate
        approval={approval}
        count={1}
        respond={vi.fn()}
        sendGuidance={sendGuidance}
        guidance="   "
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Decline — tell it what to do instead" }),
    );
    expect(sendGuidance).not.toHaveBeenCalled();
  });

  it("selects by letter key while focus is inside the gate", () => {
    const respond = vi.fn();
    const { container } = render(
      <V2ApprovalGate approval={approval} count={1} respond={respond} />,
    );

    const group = container.querySelector('[data-slot="v2-approval-options"]')!;
    fireEvent.keyDown(group, { key: "b" });
    expect(respond).toHaveBeenLastCalledWith("approval-1", "acceptForSession");
  });

  it("leaves modified letter presses to the browser", () => {
    const respond = vi.fn();
    const { container } = render(
      <V2ApprovalGate approval={approval} count={1} respond={respond} />,
    );

    const group = container.querySelector('[data-slot="v2-approval-options"]')!;
    fireEvent.keyDown(group, { key: "a", metaKey: true });
    expect(respond).not.toHaveBeenCalled();
  });

  it("does nothing on Escape — the agent is still waiting", () => {
    const respond = vi.fn();
    const { container } = render(
      <V2ApprovalGate approval={approval} count={1} respond={respond} />,
    );

    const group = container.querySelector('[data-slot="v2-approval-options"]')!;
    fireEvent.keyDown(group, { key: "Escape" });
    expect(respond).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-slot="v2-approval-gate"]'),
    ).not.toBeNull();
  });
});
