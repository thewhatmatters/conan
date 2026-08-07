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

const question: PendingApproval = {
  ...approval,
  toolKind: "other",
  toolName: "AskUserQuestion",
  requiresUserInteraction: true,
  input: {
    questions: [
      {
        header: "Destination",
        question: "Where should this note go?",
        multiSelect: false,
        options: [
          { label: "Vault", description: "Curate it to Obsidian" },
          { label: "Archive", description: "Keep it out of the active vault" },
        ],
      },
    ],
  },
};

const multipleQuestions: PendingApproval = {
  ...question,
  input: {
    questions: [
      ...(question.input as { questions: unknown[] }).questions,
      {
        header: "Style",
        question: "How should the note be written?",
        multiSelect: false,
        options: [
          { label: "Concise", description: "Keep only the essentials" },
          { label: "Detailed", description: "Preserve supporting context" },
        ],
      },
    ],
  },
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

  it("never offers session auto-allow for an interactive question", () => {
    expect(optionsFor(question).map((o) => o.decision)).toEqual([
      "accept",
      "decline",
      "cancel",
    ]);
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
  it("renders AskUserQuestion as choices and returns answers in updatedInput", () => {
    const respond = vi.fn();
    render(<V2ApprovalGate approval={question} count={1} respond={respond} />);

    expect(screen.queryByRole("button", { name: "Always allow this session" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Vault/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(respond).toHaveBeenCalledWith("approval-1", "accept", {
      ...(question.input as Record<string, unknown>),
      answers: { "Where should this note go?": "Vault" },
    });
  });

  it("wraps long code-like question copy instead of clipping it", () => {
    const longToken = "const_reallyLongIdentifierWithoutNaturalBreaks_0123456789";
    render(
      <V2ApprovalGate
        approval={{
          ...question,
          input: {
            questions: [{
              header: "Implementation",
              question: `Review this:\n${longToken}`,
              multiSelect: false,
              options: [{ label: longToken, description: `Use:\n${longToken}` }],
            }],
          },
        }}
        count={1}
        respond={vi.fn()}
      />,
    );

    for (const node of screen.getAllByText((content) => content.includes(longToken))) {
      expect(node).toHaveStyle({ overflowWrap: "anywhere", whiteSpace: "pre-wrap" });
    }
  });

  it("requires every question and supports a free-text Other answer", () => {
    const respond = vi.fn();
    render(<V2ApprovalGate approval={question} count={1} respond={respond} />);
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    expect(respond).not.toHaveBeenCalled();

    const otherInput = screen.getByRole("textbox", { name: "Other answer for Destination" });
    expect(otherInput).toHaveAttribute("placeholder", "Type something");
    expect(screen.queryByText("Other")).toBeNull();
    fireEvent.change(otherInput, {
      target: { value: "Research folder" },
    });
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(respond).toHaveBeenCalledWith("approval-1", "accept", {
      ...(question.input as Record<string, unknown>),
      answers: { "Where should this note go?": "Research folder" },
    });
  });

  it("steps through multiple questions and preserves answers across Back and Next", () => {
    const respond = vi.fn();
    render(<V2ApprovalGate approval={multipleQuestions} count={1} respond={respond} />);

    expect(screen.getByText("Question 1 of 2")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Question progress" })).toHaveProperty("value", 1);
    expect(screen.getByRole("radio", { name: /Vault/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Concise/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answers" })).toBeNull();
    const initialActions = screen.getAllByRole("button").map((button) => button.textContent);
    expect(initialActions.indexOf("Cancel turn")).toBeLessThan(initialActions.indexOf("Next question"));

    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
    expect(screen.getByText("Question 1 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Vault/ }));
    expect(screen.getByRole("button", { name: "Next question" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));

    expect(screen.getByText("Question 2 of 2")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Vault/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Concise/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radio", { name: /Vault/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    fireEvent.click(screen.getByRole("radio", { name: /Concise/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(respond).toHaveBeenCalledWith("approval-1", "accept", {
      ...(multipleQuestions.input as Record<string, unknown>),
      answers: {
        "Where should this note go?": "Vault",
        "How should the note be written?": "Concise",
      },
    });
  });

  it("shows and handles answer shortcuts without intercepting Other text", () => {
    const { container } = render(
      <V2ApprovalGate approval={question} count={1} respond={vi.fn()} />,
    );
    const gate = container.querySelector('[data-slot="v2-question-gate"]')!;

    expect(screen.getByRole("img", { name: "1" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "3" })).toBeTruthy();

    fireEvent.keyDown(gate, { key: "2" });
    const archive = screen.getByRole("radio", { name: /Archive/ });
    expect(archive).toBeChecked();
    expect(document.activeElement).toBe(archive);

    const other = screen.getByRole("textbox", { name: "Other answer for Destination" });
    fireEvent.change(other, { target: { value: "Folder 2" } });
    fireEvent.keyDown(other, { key: "1" });
    expect(other).toHaveValue("Folder 2");
    expect(screen.getByRole("radio", { name: /Vault/ })).not.toBeChecked();
  });

  it("does not show stepper chrome for a single question", () => {
    render(<V2ApprovalGate approval={question} count={1} respond={vi.fn()} />);

    expect(screen.queryByRole("progressbar", { name: "Question progress" })).toBeNull();
    expect(screen.queryByText(/Question 1 of/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeTruthy();
  });

  it("fails recoverably when an AskUserQuestion payload is malformed", () => {
    const respond = vi.fn();
    render(
      <V2ApprovalGate
        approval={{ ...question, input: { questions: [] } }}
        count={1}
        respond={respond}
      />,
    );
    expect(screen.getByText("This question could not be displayed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve once" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel turn" }));
    expect(respond).toHaveBeenCalledWith("approval-1", "cancel");
  });

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

/**
 * The announcer is asserted in V2ChatView's own suite rather than here: what
 * matters is that the node exists BEFORE any approval does, which is a property
 * of the view, not of the gate.
 */
