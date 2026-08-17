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
import { fireEvent, render, screen } from "@testing-library/react";
import Sidebar from "../Sidebar.tsx";

describe("Sidebar", () => {
  it("is a labelled navigation region at the artboard's width", () => {
    render(<Sidebar />);

    expect(
      screen.getByRole("navigation", { name: "Projects and threads" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Projects and threads" }),
    ).toHaveAttribute("data-slot", "sidebar-panel");
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

  it("renders a labelled search button and labelled native action buttons", () => {
    render(<Sidebar />);

    // WHA-70 opener is a button (not a read-only searchbox) so Esc after open
    // can restore focus without re-opening the palette.
    const search = screen.getByRole("button", {
      name: "Search projects and threads",
    });
    expect(search).toHaveAttribute("aria-haspopup", "dialog");
    expect(search).toHaveAttribute("type", "button");
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
  });

  // WHA-60 applies the Add-project rule below to Sort as well. The slot shipped
  // enabled and inert while the story was deferred; now that a real menu exists,
  // an enabled control with no menu behind it is the same silent no-op.
  it("disables Sort projects until the shell supplies the menu", () => {
    const { unmount } = render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Sort projects" })).toBeDisabled();
    unmount();

    render(<Sidebar sortMenu={<button type="button">Sort projects</button>} />);
    expect(screen.getByRole("button", { name: "Sort projects" })).toBeEnabled();
  });

  // WHA-74: Add project used to render enabled with no handler, so clicking it
  // silently did nothing — the state Randy got stuck in. Disabled without a
  // callback is the honest rendering; the shell always supplies one.
  it("disables Add project until the shell supplies a handler", () => {
    const { unmount } = render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Add project" })).toBeDisabled();
    unmount();

    render(<Sidebar onAddProject={() => {}} />);
    expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled();
  });

  it("exposes and updates project expansion state on native buttons", () => {
    render(<Sidebar />);

    const conanToggle = screen.getByRole("button", { name: "Collapse Conan" });
    expect(conanToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(conanToggle);

    expect(
      screen.getByRole("button", { name: "Expand Conan" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    ).not.toBeInTheDocument();
  });

  it("renders thread rows as labelled buttons and conveys selection", () => {
    render(<Sidebar />);

    expect(
      screen.getByRole("button", {
        name: "Analyze my project: Run serverless code...",
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", {
        name: "Code Validation: Run the /code-design skill....",
      }),
    ).not.toHaveAttribute("aria-current");
  });
});
