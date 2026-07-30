/**
 * SurfaceTabs — Paper RJ-0 node HL-0.
 *
 * The strip's ROLES and KEYBOARD behaviour are the contract this suite guards
 * (US-101): a `tablist` of `tab`s, one Tab stop for the group with the roving
 * tabindex moving under arrow keys, and a real named close button per closeable
 * surface. Those were the four things the T0 stub got wrong — it rendered bare
 * `<div>`s no keyboard could reach — so each gets an explicit test rather than
 * one broad smoke render.
 *
 * Keyboard tests drive the real DOM: focus a tab, dispatch a keydown, and assert
 * on `document.activeElement`. The arrow handling belongs to Astryx's
 * `useListFocus`, so these read as integration checks on the wiring, not on the
 * hook's internals.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Diff, Globe, MessagesSquare } from "lucide-react";
import SurfaceTabs, { type SurfaceTab } from "../components/SurfaceTabs.tsx";

/** A three-tab strip: one permanent + two closeable, as RJ-0 has it. */
const TABS: SurfaceTab[] = [
  { id: "chat", label: "Chat", icon: MessagesSquare, isSelected: true },
  { id: "browser", label: "Browser", icon: Globe, isCloseable: true },
  { id: "diff", label: "Diff", icon: Diff, isCloseable: true },
];

const tabNames = () =>
  screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());

/**
 * A closeable tab's accessible name folds in its ✕ ("Browser Close Browser
 * tab"), so tabs are addressed by a leading-label regex throughout.
 */
const tab = (label: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${label}`) });

describe("SurfaceTabs", () => {
  it("is a labelled tablist of tabs, in the artboard's order", () => {
    render(<SurfaceTabs />);

    const tablist = screen.getByRole("tablist", { name: "Surfaces" });
    expect(tablist).toBeInTheDocument();
    expect(tabNames()).toEqual(["Chat", "Browser", "Terminal", "Diff"]);
    screen
      .getAllByRole("tab")
      .forEach((tab) => expect(tablist).toContainElement(tab));
  });

  it("marks the selected surface with aria-selected, the rest false", () => {
    render(<SurfaceTabs tabs={TABS} />);

    expect(tab("Chat")).toHaveAttribute("aria-selected", "true");
    expect(tab("Browser")).toHaveAttribute("aria-selected", "false");
    expect(tab("Diff")).toHaveAttribute("aria-selected", "false");
  });

  it("is ONE Tab stop: the selected tab is tabbable, the others are not", () => {
    render(<SurfaceTabs tabs={TABS} />);

    expect(tab("Chat")).toHaveAttribute("tabindex", "0");
    expect(tab("Browser")).toHaveAttribute("tabindex", "-1");
    expect(tab("Diff")).toHaveAttribute("tabindex", "-1");
  });

  it("lets keyboard focus land on a tab", () => {
    render(<SurfaceTabs tabs={TABS} />);

    tab("Chat").focus();

    expect(tab("Chat")).toHaveFocus();
  });

  it("moves focus between tabs with the arrow keys, wrapping at the ends", () => {
    render(<SurfaceTabs tabs={TABS} />);
    tab("Chat").focus();

    fireEvent.keyDown(tab("Chat"), { key: "ArrowRight" });
    expect(tab("Browser")).toHaveFocus();

    fireEvent.keyDown(tab("Browser"), { key: "ArrowRight" });
    expect(tab("Diff")).toHaveFocus();

    // Past the last tab, focus wraps to the first.
    fireEvent.keyDown(tab("Diff"), { key: "ArrowRight" });
    expect(tab("Chat")).toHaveFocus();

    fireEvent.keyDown(tab("Chat"), { key: "ArrowLeft" });
    expect(tab("Diff")).toHaveFocus();
  });

  it("carries the tab stop with the arrow keys, so Tab returns where it left", () => {
    render(<SurfaceTabs tabs={TABS} />);
    tab("Chat").focus();

    fireEvent.keyDown(tab("Chat"), { key: "ArrowRight" });

    expect(tab("Browser")).toHaveAttribute("tabindex", "0");
    expect(tab("Chat")).toHaveAttribute("tabindex", "-1");
  });

  it("jumps to the first and last tab with Home and End", () => {
    render(<SurfaceTabs tabs={TABS} />);
    tab("Chat").focus();

    fireEvent.keyDown(tab("Chat"), { key: "End" });
    expect(tab("Diff")).toHaveFocus();

    fireEvent.keyDown(tab("Diff"), { key: "Home" });
    expect(tab("Chat")).toHaveFocus();
  });

  it("gives every closeable surface a named close BUTTON", () => {
    render(<SurfaceTabs />);

    for (const label of ["Browser", "Terminal", "Diff"]) {
      const close = screen.getByRole("button", { name: `Close ${label} tab` });
      expect(close.tagName).toBe("BUTTON");
      expect(close).toBeEnabled();
    }
  });

  it("keeps the close buttons keyboard-focusable", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const close = screen.getByRole("button", { name: "Close Browser tab" });
    close.focus();

    expect(close).toHaveFocus();
    expect(close).not.toHaveAttribute("tabindex", "-1");
  });

  it("draws no close affordance on the permanent Chat tab", () => {
    render(<SurfaceTabs tabs={TABS} />);

    expect(tab("Chat").querySelector("button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Close Chat tab" }),
    ).not.toBeInTheDocument();
  });

  it("reports the tab a click, Enter or Space selected", () => {
    const onSelect = vi.fn();
    render(<SurfaceTabs tabs={TABS} onSelect={onSelect} />);

    fireEvent.click(tab("Browser"));
    fireEvent.keyDown(tab("Browser"), { key: "Enter" });
    fireEvent.keyDown(tab("Browser"), { key: " " });

    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith("browser");
  });

  it("closes a surface without also selecting it", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<SurfaceTabs tabs={TABS} onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close Diff tab" }));

    expect(onClose).toHaveBeenCalledWith("diff");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says out loud that the Surface opener is unavailable", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const opener = screen.getByRole("button", { name: /Surface/ });
    expect(opener).toHaveAttribute("aria-disabled", "true");
    expect(opener).not.toHaveAttribute("tabindex");
  });
});
