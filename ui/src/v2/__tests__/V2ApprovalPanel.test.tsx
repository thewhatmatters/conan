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
  input: { command: "npm test" },
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
        approval={{
          ...approval,
          toolKind: "other",
          toolName: "ExitPlanMode",
          detail: "# Proposed approach\n\n- Render the plan\n- Verify the flow",
        }}
        count={1}
        respond={vi.fn()}
      />,
    );

    const panel = screen.getByRole("region", { name: "Plan approval" });
    expect(panel).toHaveAttribute("aria-live", "assertive");
    expect(panel).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByRole("heading", { name: "Proposed approach" })).toBeInTheDocument();
    expect(screen.getByText("Render the plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed in build" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Keep planning" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Always allow this session" }),
    ).not.toBeInTheDocument();
  });

  it("renders an Edit as a real diff with the full path (Defect 2)", () => {
    render(
      <V2ApprovalPanel
        approval={{
          ...approval,
          toolKind: "file-change",
          toolName: "Edit",
          detail: "/tmp/project/calc.js",
          input: {
            file_path: "/tmp/project/calc.js",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        }}
        count={1}
        respond={vi.fn()}
      />,
    );

    expect(screen.getByText("/tmp/project/calc.js")).toBeInTheDocument();
    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
    expect(screen.getByText("const a = 2;")).toBeInTheDocument();
    // A one-hunk edit fits the preview — no expand control.
    expect(
      screen.queryByRole("button", { name: /Show full diff/ }),
    ).not.toBeInTheDocument();
    // The action row is still present alongside the diff.
    expect(screen.getByRole("button", { name: "Approve once" })).toBeEnabled();
  });

  it("previews a long Write and expands to the full diff on demand", () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    render(
      <V2ApprovalPanel
        approval={{
          ...approval,
          toolKind: "file-change",
          toolName: "Write",
          detail: "/tmp/project/big.txt",
          input: { file_path: "/tmp/project/big.txt", content },
        }}
        count={1}
        respond={vi.fn()}
      />,
    );

    // Preview: first rows visible, later rows behind the expand control.
    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(screen.queryByText("line 40")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show full diff \(\+40 −0\)/ }));
    expect(screen.getByText("line 40")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("line 40")).not.toBeInTheDocument();
  });

  it("shows a structured summary for non-file tools instead of raw JSON", () => {
    render(<V2ApprovalPanel approval={approval} count={1} respond={vi.fn()} />);

    expect(screen.getByText("command")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("falls back to the detail mono block when input has no summarizable fields", () => {
    render(
      <V2ApprovalPanel
        approval={{
          ...approval,
          toolName: "SomeMcpTool",
          detail: '{"nested": {"deep": true}}',
          input: { nested: { deep: true } },
        }}
        count={1}
        respond={vi.fn()}
      />,
    );

    expect(screen.getByText('{"nested": {"deep": true}}')).toBeInTheDocument();
  });
});
