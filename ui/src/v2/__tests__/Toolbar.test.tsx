/**
 * Toolbar — Paper RJ-0 node EK-0.
 *
 * The toolbar is a COMPOSITION file (contract §4.4): its whole job is to seat
 * `Breadcrumb` left and workflow controls right. So the test asserts composition —
 * that both leaves are mounted and in the artboard's order — rather than
 * re-asserting each leaf's internals, which belong to the leaf's own suite.
 *
 * US-101 part C also pins breadcrumb + secondary-bar a11y here: real focusable
 * buttons with accessible names (and menu ARIA on the secondary-bar triggers).
 * SecondaryBar lives in the content well (App.v2), not the toolbar composition
 * file — still tested here as the toolbar-region a11y sweep, and via direct
 * render so the suite stays free of App.v2 coupling.
 *
 * Queries go through the `data-slot` attributes the components already carry;
 * no test-only markup was added.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Toolbar from "../Toolbar.tsx";
import Breadcrumb from "../components/Breadcrumb.tsx";
import SecondaryBar from "../components/SecondaryBar.tsx";

describe("Toolbar", () => {
  it("mounts the breadcrumb and workflow controls", () => {
    const { container } = render(<Toolbar />);

    const toolbar = container.querySelector('[data-slot="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="breadcrumb"]')).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="workflow-controls"]')).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="surface-tabs"]')).toBeNull();
  });

  it("puts the crumb before the workflow controls", () => {
    const { container } = render(<Toolbar />);
    const slots = Array.from(
      container.querySelectorAll('[data-slot="breadcrumb"], [data-slot="workflow-controls"]'),
    ).map((node) => node.getAttribute("data-slot"));

    expect(slots).toEqual(["breadcrumb", "workflow-controls"]);
  });

  it("renders the crumb's project and thread text", () => {
    render(<Toolbar />);

    expect(screen.getByText("Conan")).toBeInTheDocument();
    expect(screen.getByText("Analyze my project")).toBeInTheDocument();
  });

  it("moves Open and Commit & Push into the top toolbar", () => {
    render(<Toolbar />);

    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit and Push menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions menu" })).toBeNull();
  });
});

describe("Breadcrumb a11y (US-101 C)", () => {
  it("exposes the parent crumb as a real button named Back to <project>", () => {
    render(<Breadcrumb project="Conan" thread="Analyze my project" />);

    const parent = screen.getByRole("button", { name: "Back to Conan" });
    expect(parent).toBeInTheDocument();
    expect(parent.tagName).toBe("BUTTON");
    expect(parent).toHaveAttribute("type", "button");
  });

  // WHA-104 made the leaf a switcher when the project has siblings to switch
  // to; with no `threads` prop it is still the static current-page text. The
  // switcher's own contract lives in `BreadcrumbThreadMenu.test.tsx`.
  it("keeps the leaf thread title as static text, not a button", () => {
    render(<Breadcrumb project="Conan" thread="Analyze my project" />);

    expect(screen.getByText("Analyze my project").closest("button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Analyze my project/i }),
    ).not.toBeInTheDocument();
  });

  it("uses the project prop in the accessible name", () => {
    render(<Breadcrumb project="acme-api" thread="Wire auth" />);

    expect(screen.getByRole("button", { name: "Back to acme-api" })).toBeInTheDocument();
  });
});

describe("SecondaryBar a11y (US-101 C)", () => {
  it("exposes the Chat/surfaces toggle group and right-side Actions button", () => {
    render(<SecondaryBar />);

    expect(screen.getByRole("group", { name: "Chat and surfaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const actions = screen.getByRole("button", { name: "Actions menu" });
    expect(actions.tagName).toBe("BUTTON");
    expect(actions).toHaveAttribute("type", "button");
    expect(actions).toHaveAttribute("aria-haspopup", "menu");
    expect(actions).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles aria-expanded on Actions", () => {
    render(<SecondaryBar />);

    const actions = screen.getByRole("button", { name: "Actions menu" });

    fireEvent.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps workflow menu expansion exclusive in the toolbar", () => {
    render(<Toolbar />);

    const open = screen.getByRole("button", { name: "Open menu" });
    const commit = screen.getByRole("button", { name: "Commit and Push menu" });

    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(commit);
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(commit).toHaveAttribute("aria-expanded", "true");
  });

  it("paints the WHA-156 labels in their new bars", () => {
    const { rerender } = render(<Toolbar />);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Commit & Push")).toBeInTheDocument();

    rerender(<SecondaryBar />);
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });
});
