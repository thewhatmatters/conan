/**
 * The WHA-55 announcer — the whole reason WHA-86's architecture change earns
 * its keep.
 *
 * The old panel put `aria-live` on a node that was INSERTED at the same instant
 * it gained content. That is the one shape screen readers reliably do not
 * announce, and it is why the original defect was filed. The fix is not "add a
 * live region" — the old code had one. The fix is that the region must already
 * be in the document before there is anything to say, so the arrival of an
 * approval is a text MUTATION.
 *
 * That distinction is a DOM property, so jsdom can settle it honestly: assert
 * the node exists while `pendingApproval` is null, and that the same node —
 * not a replacement — carries text once one arrives.
 *
 * What this does NOT prove is that a screen reader speaks. That needs a real
 * AT and is called out as unverified in the handoff.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PendingApproval } from "../lib/useV2Chat.ts";

const chat = {
  items: [] as unknown[],
  send: vi.fn(),
  status: "open" as const,
  busy: false,
  awaitingApproval: false,
  pendingApproval: null as PendingApproval | null,
  pendingApprovals: [] as PendingApproval[],
  respondToApproval: vi.fn(),
  interrupt: vi.fn(),
  contextTokens: null as number | null,
  capabilities: null as {
    contextWindowTokens: number | null;
    permissionModes: unknown[];
  } | null,
};

vi.mock("../lib/useV2Chat.ts", () => ({ useV2Chat: () => chat }));
vi.mock("../lib/useV2ThreadHistory.ts", () => ({
  useV2ThreadHistory: () => ({ items: [], resumeSessionId: null, missing: false }),
}));
// Partial: this module exports label helpers the composer needs, and stubbing
// them by hand makes the test brittle against changes it does not care about.
vi.mock("../lib/useV2Providers.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/useV2Providers.ts")>()),
  useV2Providers: () => [],
}));

const { default: V2ChatView } = await import("../chat/V2ChatView.tsx");

const approval: PendingApproval = {
  id: "a1",
  toolKind: "command",
  toolName: "Bash",
  toolUseId: "t1",
  summary: "Run the tests",
  detail: "npm test",
  input: { command: "npm test" },
};

const thread = { sessionId: null, cwd: "/tmp/x", projectName: "x", title: "x" };

beforeEach(() => {
  chat.pendingApproval = null;
  chat.pendingApprovals = [];
  chat.awaitingApproval = false;
  chat.contextTokens = null;
  chat.capabilities = null;
});

describe("context position navigation", () => {
  it("restores the last honest reading for the same thread only", () => {
    const persistentThread = {
      key: "context-persist-thread",
      sessionId: "session-1",
      cwd: "/tmp/x",
      projectName: "x",
      provider: "claude",
      title: "x",
    };
    chat.contextTokens = 45_000;
    chat.capabilities = {
      contextWindowTokens: 200_000,
      permissionModes: [],
    };
    const first = render(
      <V2ChatView token="tok" activeThread={persistentThread as never} />,
    );
    expect(screen.getByRole("progressbar", { name: "Context" })).toBeTruthy();
    first.unmount();

    chat.contextTokens = null;
    chat.capabilities = null;
    const restored = render(
      <V2ChatView token="tok" activeThread={persistentThread as never} />,
    );
    expect(screen.getByRole("progressbar", { name: "Context" })).toBeTruthy();
    restored.unmount();

    render(
      <V2ChatView
        token="tok"
        activeThread={{ ...persistentThread, key: "different-thread" } as never}
      />,
    );
    expect(screen.queryByRole("progressbar", { name: "Context" })).toBeNull();
  });

  it("confirms and announces a measured reset, then offers the fresh-thread action", () => {
    const onStartNewThread = vi.fn();
    const pressuredThread = {
      key: "context-compaction-thread",
      sessionId: "session-compaction",
      cwd: "/tmp/x",
      projectId: "project-x",
      projectName: "x",
      provider: "claude",
      title: "x",
    };
    chat.contextTokens = 192_000;
    chat.capabilities = {
      contextWindowTokens: 200_000,
      permissionModes: [],
    };
    const { container, rerender } = render(
      <V2ChatView
        token="tok"
        activeThread={pressuredThread as never}
        onStartNewThread={onStartNewThread}
      />,
    );

    expect(screen.getByText(/Claude will compact when needed/)).toBeInTheDocument();
    const announcer = container.querySelector(
      '[data-slot="v2-context-compaction-announcer"]',
    );
    expect(announcer).not.toBeNull();
    expect(announcer).toHaveAttribute("aria-live", "polite");
    expect(announcer?.textContent).toBe("");
    screen.getByRole("button", { name: "Start new thread" }).click();
    expect(onStartNewThread).toHaveBeenCalledOnce();

    chat.contextTokens = 76_000;
    rerender(
      <V2ChatView
        token="tok"
        activeThread={pressuredThread as never}
        onStartNewThread={onStartNewThread}
      />,
    );

    expect(
      container.querySelector('[data-slot="context-compaction-confirmation"]'),
    ).toHaveTextContent("Context compacted · 96% → 38%");
    expect(
      container.querySelector('[data-slot="v2-context-compaction-announcer"]'),
    ).toBe(announcer);
    expect(announcer?.textContent).toBe("Context compacted · 96% → 38%");
  });
});

describe("approval announcer (WHA-55)", () => {
  it("is already mounted, and empty, before any approval exists", () => {
    const { container } = render(
      <V2ChatView token="tok" activeThread={thread as never} />,
    );

    const node = container.querySelector('[data-slot="v2-approval-announcer"]');
    expect(node).not.toBeNull();
    expect(node).toHaveAttribute("aria-live", "polite");
    expect(node?.textContent).toBe("");
  });

  it("MUTATES that same node when an approval arrives — no insertion", () => {
    const { container, rerender } = render(
      <V2ChatView token="tok" activeThread={thread as never} />,
    );
    const before = container.querySelector('[data-slot="v2-approval-announcer"]');

    chat.pendingApproval = approval;
    chat.pendingApprovals = [approval];
    chat.awaitingApproval = true;
    rerender(<V2ChatView token="tok" activeThread={thread as never} />);

    const after = container.querySelector('[data-slot="v2-approval-announcer"]');
    // Identity, not just presence: a fresh node would be an insertion again.
    expect(after).toBe(before);
    expect(after?.textContent).toContain("Permission needed for Bash");
  });

  it("says a plan is ready rather than naming ExitPlanMode at the user", () => {
    chat.pendingApproval = { ...approval, toolName: "ExitPlanMode" };
    chat.pendingApprovals = [chat.pendingApproval];
    const { container } = render(
      <V2ChatView token="tok" activeThread={thread as never} />,
    );

    expect(
      container.querySelector('[data-slot="v2-approval-announcer"]')?.textContent,
    ).toContain("Plan ready");
  });

  it("keeps the composer mounted while an approval is pending", () => {
    chat.pendingApproval = approval;
    chat.pendingApprovals = [approval];
    const { container } = render(
      <V2ChatView token="tok" activeThread={thread as never} />,
    );

    expect(container.querySelector('[data-slot="v2-composer"]')).not.toBeNull();
    const composerMeasure = container.querySelector('[data-slot="v2-composer"]')?.parentElement;
    expect(getComputedStyle(composerMeasure!).paddingBottom).toBe(
      "calc(var(--conan-space-4) + var(--conan-space-1))",
    );
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeNull();
  });
});
