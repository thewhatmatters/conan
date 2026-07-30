/**
 * Toolbar — Paper RJ-0 node EK-0.
 *
 * The toolbar is a COMPOSITION file (contract §4.4): its whole job is to seat
 * `Breadcrumb` left and `SurfaceTabs` right. So the test asserts composition —
 * that both leaves are mounted and in the artboard's order — rather than
 * re-asserting each leaf's internals, which belong to the leaf's own suite.
 *
 * Queries go through the `data-slot` attributes the components already carry;
 * no test-only markup was added.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Toolbar from "../Toolbar.tsx";

describe("Toolbar", () => {
  it("mounts the breadcrumb and the surface tab strip", () => {
    const { container } = render(<Toolbar />);

    const toolbar = container.querySelector('[data-slot="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="breadcrumb"]')).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="surface-tabs"]')).not.toBeNull();
  });

  it("puts the crumb before the tab strip, as RJ-0 does", () => {
    const { container } = render(<Toolbar />);
    const slots = Array.from(
      container.querySelectorAll('[data-slot="breadcrumb"], [data-slot="surface-tabs"]'),
    ).map((node) => node.getAttribute("data-slot"));

    expect(slots).toEqual(["breadcrumb", "surface-tabs"]);
  });

  it("renders the crumb's project and thread text", () => {
    render(<Toolbar />);

    expect(screen.getByText("Conan")).toBeInTheDocument();
    expect(screen.getByText("Analyze my project")).toBeInTheDocument();
  });

  it("renders the artboard's surface tabs as a tablist with Chat selected", () => {
    render(<Toolbar />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.replace(/Close .*/, ""))).toEqual([
      "Chat",
      "Browser",
      "Terminal",
      "Diff",
    ]);
    expect(screen.getByRole("tablist", { name: "Surfaces" })).toBeInTheDocument();
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });
});
