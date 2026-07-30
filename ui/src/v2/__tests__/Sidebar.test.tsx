/**
 * Sidebar — Paper RJ-0 node 4M-0.
 *
 * Composition again (contract §4.4): header band, scrolling tree, pinned
 * footer. The one assertion here that is a REGRESSION GUARD rather than a
 * description is the NewChatButton absence — RJ-0's footer (7L-0) draws
 * Settings and nothing else, the leaf file is kept for a later surface, and
 * "someone re-mounts it because the file is sitting there" is the exact
 * mistake this suite exists to catch.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Sidebar from "../Sidebar.tsx";

describe("Sidebar", () => {
  it("is a labelled navigation region at the artboard's width", () => {
    render(<Sidebar />);

    expect(
      screen.getByRole("navigation", { name: "Projects and threads" }),
    ).toBeInTheDocument();
  });

  it("mounts the header, the project tree and the settings footer", () => {
    const { container } = render(<Sidebar />);

    expect(container.querySelector('[data-slot="sidebar-header"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="search-input"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="project-tree"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="settings-footer"]')).not.toBeNull();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("does NOT render NewChatButton — RJ-0's footer holds Settings alone", () => {
    const { container } = render(<Sidebar />);

    expect(container.querySelector('[data-slot="new-chat-button"]')).toBeNull();
    expect(screen.queryByText("New chat")).not.toBeInTheDocument();
  });

  it("keeps the footer last, so Settings stays pinned to the bottom", () => {
    const { container } = render(<Sidebar />);
    const column = container.querySelector('[data-slot="sidebar"]');

    const last = column?.lastElementChild;
    expect(last?.querySelector('[data-slot="settings-footer"]')).not.toBeNull();
  });
});
