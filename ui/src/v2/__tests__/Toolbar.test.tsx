/**
 * Toolbar — Paper 2SJ-0 node EK-0.
 *
 * The toolbar is a COMPOSITION file (contract §4.4): its whole job is to seat
 * `Breadcrumb` left and the surface tab strip right. Workflow controls
 * (Actions/Open/Commit & Push) now live inside the Chat surface, not here.
 *
 * US-101 part C also pins breadcrumb a11y here: real focusable buttons with
 * accessible names. The tab strip's own a11y is tested in SurfaceTabs.test.tsx.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessagesSquare, Terminal } from "lucide-react";
import Toolbar from "../Toolbar.tsx";
import Breadcrumb from "../components/Breadcrumb.tsx";
import ChatSurfaceToolbar from "../components/ChatSurfaceToolbar.tsx";
import type { SurfaceTab } from "../components/SurfaceTabs.tsx";

const TABS: SurfaceTab[] = [
  { id: "chat", label: "Chat", icon: MessagesSquare, isSelected: true },
  { id: "terminal", label: "Terminal", icon: Terminal, isCloseable: true },
];

describe("Toolbar", () => {
  it("mounts the breadcrumb and surface tabs", () => {
    const { container } = render(<Toolbar tabs={TABS} />);

    const toolbar = container.querySelector('[data-slot="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="breadcrumb"]')).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="surface-tabs"]')).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="workflow-controls"]')).toBeNull();
  });

  it("puts the crumb before the surface tabs", () => {
    const { container } = render(<Toolbar tabs={TABS} />);
    const slots = Array.from(
      container.querySelectorAll('[data-slot="breadcrumb"], [data-slot="surface-tabs"]'),
    ).map((node) => node.getAttribute("data-slot"));

    expect(slots).toEqual(["breadcrumb", "surface-tabs"]);
  });

  it("renders the crumb's project and thread text", () => {
    render(<Toolbar tabs={TABS} />);

    expect(screen.getByText("Conan")).toBeInTheDocument();
    expect(screen.getByText("Analyze my project")).toBeInTheDocument();
  });

  it("does not render workflow controls in the toolbar", () => {
    render(<Toolbar tabs={TABS} />);

    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit and Push menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions menu" })).toBeNull();
  });

  it("forwards surface tab callbacks", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Toolbar tabs={TABS} onSelect={onSelect} onOpen={onOpen} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onSelect).toHaveBeenCalledWith("terminal");

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal tab" }));
    expect(onClose).toHaveBeenCalledWith("terminal");
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
  // switcher's own contract lives in BreadcrumbThreadMenu.test.tsx.
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

describe("ChatSurfaceToolbar a11y (WHA-158)", () => {
  it("exposes Actions, Open, and Commit & Push as real menu buttons", () => {
    render(<ChatSurfaceToolbar />);

    for (const name of ["Actions menu", "Open menu", "Commit and Push menu"]) {
      const button = screen.getByRole("button", { name });
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      expect(button).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("toggles aria-expanded on Actions", () => {
    render(<ChatSurfaceToolbar />);

    const actions = screen.getByRole("button", { name: "Actions menu" });

    fireEvent.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(actions);
    expect(actions).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps workflow menu expansion exclusive", () => {
    render(<ChatSurfaceToolbar />);

    const open = screen.getByRole("button", { name: "Open menu" });
    const commit = screen.getByRole("button", { name: "Commit and Push menu" });

    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(commit);
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(commit).toHaveAttribute("aria-expanded", "true");
  });

});
