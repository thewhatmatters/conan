import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import V2ApprovalPanel from "../chat/V2ApprovalPanel.tsx";
import type { PendingApproval } from "../lib/useV2Chat.ts";

const approval: PendingApproval = {
  id: "approval-1",
  toolKind: "command",
  toolName: "Bash",
  toolUseId: "tool-1",
  summary: "Run the test suite",
  detail: "npm test",
};

describe("V2ApprovalPanel", () => {
  it("maps every permission action to the driver decision", () => {
    const respond = vi.fn();
    render(
      <V2ApprovalPanel approval={approval} count={2} respond={respond} />,
    );

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    for (const [label, decision] of [
      ["Approve once", "accept"],
      ["Always allow this session", "acceptForSession"],
      ["Decline", "decline"],
      ["Cancel turn", "cancel"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(respond).toHaveBeenLastCalledWith("approval-1", decision);
    }
  });

  it("uses plan language without widening all other tools", () => {
    render(
      <V2ApprovalPanel
        approval={{ ...approval, toolKind: "other", toolName: "ExitPlanMode" }}
        count={1}
        respond={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Plan approval" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed in build" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Keep planning" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Always allow this session" }),
    ).not.toBeInTheDocument();
  });
});
