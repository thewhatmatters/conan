/**
 * V2ApprovalContent — WHAT is being approved.
 *
 * The decision buttons moved to `V2ApprovalGate` in WHA-86, so the
 * action-mapping test moved with them (see V2ApprovalGate.test.tsx). What
 * belongs here is the content contract: plan wording, the Defect-2 diff, the
 * structured summary, and the raw-detail fallback.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import V2ApprovalContent from "../chat/V2ApprovalPanel.tsx";
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

describe("V2ApprovalContent", () => {
  it("renders the tool's detail and the queue depth", () => {
    render(<V2ApprovalContent approval={approval} count={2} />);

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("carries no live region — the gate owns announcement now (WHA-55)", () => {
    const { container } = render(
      <V2ApprovalContent approval={approval} count={1} />,
    );

    // The old panel was inserted WITH aria-live, which is why screen readers
    // never announced it. Announcement belongs to the always-mounted gate.
    expect(container.querySelector("[aria-live]")).toBeNull();
  });

  it("uses plan language without widening all other tools", () => {
    render(
      <V2ApprovalContent
        approval={{
          ...approval,
          toolKind: "other",
          toolName: "ExitPlanMode",
          detail: "# Proposed approach\n\n- Render the plan\n- Verify the flow",
        }}
        count={1}
      />,
    );

    expect(screen.getByText("Plan ready")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proposed approach" })).toBeInTheDocument();
    expect(screen.getByText("Render the plan")).toBeInTheDocument();
    // The option set for a plan (no "always allow") is the gate's contract now.
  });

  it("renders an Edit as a real diff with the full path (Defect 2)", () => {
    render(
      <V2ApprovalContent
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
      />,
    );

    expect(screen.getByText("/tmp/project/calc.js")).toBeInTheDocument();
    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
    expect(screen.getByText("const a = 2;")).toBeInTheDocument();
    // A one-hunk edit fits the preview — no expand control.
    expect(
      screen.queryByRole("button", { name: /Show full diff/ }),
    ).not.toBeInTheDocument();
  });

  it("previews a long Write and expands to the full diff on demand", () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    render(
      <V2ApprovalContent
        approval={{
          ...approval,
          toolKind: "file-change",
          toolName: "Write",
          detail: "/tmp/project/big.txt",
          input: { file_path: "/tmp/project/big.txt", content },
        }}
        count={1}
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
    render(<V2ApprovalContent approval={approval} count={1} />);

    expect(screen.getByText("command")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("falls back to the detail mono block when input has no summarizable fields", () => {
    render(
      <V2ApprovalContent
        approval={{
          ...approval,
          toolName: "SomeMcpTool",
          detail: '{"nested": {"deep": true}}',
          input: { nested: { deep: true } },
        }}
        count={1}
      />,
    );

    expect(screen.getByText('{"nested": {"deep": true}}')).toBeInTheDocument();
  });
});
