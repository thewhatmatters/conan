/**
 * AppV2 — the v2 shell. Paper artboard RJ-0 "Application Shell".
 *
 * The shell's contract is a region layout: sidebar beside a main column of
 * toolbar → lifted content well, and the secondary bar is the FIRST thing
 * INSIDE that well rather than part of the toolbar. That placement is a design
 * decision worth pinning (it is what lets the well's 24px corner show), so the
 * test asserts containment, not just presence.
 *
 * Note the title bar: RJ-0 draws one (RK-0) and `App.v2.tsx` deliberately does
 * not render it, because Conan's Tauri window keeps its native chrome. Asserted
 * below so the omission stays a decision instead of decaying into an oversight.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AppV2 from "../App.v2.tsx";

describe("AppV2 shell", () => {
  it("renders the sidebar and the toolbar", () => {
    const { container } = render(<AppV2 />);

    expect(container.querySelector('[data-slot="sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="toolbar"]')).not.toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Projects and threads" }),
    ).toBeInTheDocument();
  });

  it("seats the secondary bar inside the content well, below the toolbar", () => {
    const { container } = render(<AppV2 />);

    const main = container.querySelector('[data-slot="main"]');
    const toolbar = main?.querySelector('[data-slot="toolbar"]') ?? null;
    const secondaryBar = main?.querySelector('[data-slot="secondary-bar"]') ?? null;

    expect(toolbar).not.toBeNull();
    expect(secondaryBar).not.toBeNull();
    if (!toolbar || !secondaryBar) return;

    // Nesting would mean the bar is part of the toolbar row; it is not — it
    // belongs to the well below, which is what lets the well's corner show.
    expect(toolbar.contains(secondaryBar)).toBe(false);
    expect(
      toolbar.compareDocumentPosition(secondaryBar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the secondary bar's three controls", () => {
    render(<AppV2 />);

    for (const label of ["Actions", "Open", "Commit & Push"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("hosts V2ChatView (ChatLayout) in the content well", () => {
    const { container } = render(<AppV2 />);

    expect(container.querySelector('[data-slot="content"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-view="v2"]')).not.toBeNull();
    expect(
      screen.getByText("Select a thread to start chatting."),
    ).toBeInTheDocument();
  });

  it("selecting a sidebar thread updates the chat empty-state copy", () => {
    render(<AppV2 />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    );

    expect(
      screen.getByText("Send a message to start this thread."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("does not paint a second title bar over the native window chrome", () => {
    render(<AppV2 />);

    // RK-0's traffic lights + wordmark are the artboard's mock of macOS chrome.
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});
