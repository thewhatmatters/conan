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
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Diff, Globe, MessagesSquare, Terminal } from "lucide-react";
import SurfaceTabs, { type SurfaceTab } from "../components/SurfaceTabs.tsx";

/** A three-tab strip: one permanent + two closeable, as RJ-0 has it. */
const TABS: SurfaceTab[] = [
  { id: "chat", label: "Chat", icon: MessagesSquare, isSelected: true },
  { id: "browser", label: "Browser", icon: Globe, isCloseable: true },
  { id: "diff", label: "Diff", icon: Diff, isCloseable: true },
];

const tabNames = () =>
  screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());

/** Tabs expose their visible label as the accessible name. */
const tab = (label: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${label}`) });

describe("SurfaceTabs", () => {
  it("is a labelled tablist of tabs, in the artboard's order", () => {
    render(<SurfaceTabs />);

    const tablist = screen.getByRole("tablist", { name: "Surfaces" });
    expect(tablist).toBeInTheDocument();
    expect(tabNames()).toEqual(["Chat"]);
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

  it("reveals a named kebab menu for an undocked surface", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const options = screen.getByRole("button", { name: "Browser surface options" });
    expect(options).toBeInTheDocument();
    const actions = options.closest('[data-slot="surface-tab-actions"]')!;
    expect(getComputedStyle(actions).width).toBe("var(--conan-icon-size)");
    expect(getComputedStyle(actions).pointerEvents).toBe("auto");
    const fade = actions.querySelector('[data-slot="surface-tab-action-fade"]')!;
    expect(getComputedStyle(fade).width).toBe(
      "calc(var(--conan-space-6) + var(--conan-space-4))",
    );
    expect(getComputedStyle(fade).pointerEvents).toBe("none");
    const shell = options.closest('[data-slot="surface-tab-shell"]')!;
    expect(getComputedStyle(shell).borderRadius).toBe("var(--conan-radius-md)");
    expect(getComputedStyle(shell).overflow).toBe("hidden");
    expect(screen.queryByRole("button", { name: "Close Browser tab" })).toBeNull();
    fireEvent.click(options);
    const menu = screen.getByRole("menu", { name: "Browser surface options" });
    expect(menu).toBeVisible();
    expect(getComputedStyle(menu).pointerEvents).toBe("auto");
  });

  it("opens surface actions from the keyboard-focusable kebab", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const options = screen.getByRole("button", { name: "Browser surface options" });
    options.focus();
    expect(options).toHaveFocus();
    fireEvent.click(options);

    const menu = screen.getByRole("menu", { name: "Browser surface options" });
    expect(menu).toBeVisible();
    expect(within(menu).getByRole("menuitemradio", { name: "Right" })).toBeVisible();
  });

  it("keeps arrow navigation inside a surface context menu", () => {
    render(<SurfaceTabs tabs={TABS} />);

    fireEvent.click(screen.getByRole("button", { name: "Browser surface options" }));
    const menu = screen.getByRole("menu", { name: "Browser surface options" });
    const right = within(menu).getByRole("menuitemradio", { name: "Right" });
    const left = within(menu).getByRole("menuitemradio", { name: "Left" });
    right.focus();
    expect(right).toHaveFocus();

    fireEvent.keyDown(right, { key: "ArrowDown" });
    expect(left).toHaveFocus();
  });

  it("keeps arrow navigation inside the Surface dropdown", () => {
    render(<SurfaceTabs tabs={TABS} />);

    fireEvent.click(screen.getByRole("button", { name: "Surface" }));
    const menu = screen.getByRole("menu", { name: "Surface" });
    const terminal = within(menu).getByRole("menuitem", { name: "Terminal" });
    const files = within(menu).getByRole("menuitem", { name: "Files" });
    terminal.focus();
    expect(terminal).toHaveFocus();

    fireEvent.keyDown(terminal, { key: "ArrowDown" });
    expect(files).toHaveFocus();
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

  it("closes from the context menu without also selecting the tab", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<SurfaceTabs tabs={TABS} onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Diff surface options" }));
    const menu = screen.getByRole("menu", { name: "Diff surface options" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close Surface" }));

    expect(onClose).toHaveBeenCalledWith("diff");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers only Left and Right placement plus Close on an undocked surface", () => {
    render(<SurfaceTabs tabs={TABS} />);

    fireEvent.click(screen.getByRole("button", { name: "Browser surface options" }));
    const menu = within(screen.getByRole("menu", { name: "Browser surface options" }));
    expect(menu.getByText("Dock & Surface")).toBeVisible();
    expect(menu.getByRole("menuitemradio", { name: "Left" })).toBeVisible();
    expect(menu.getByRole("menuitemradio", { name: "Right" })).toBeVisible();
    expect(menu.queryByRole("menuitemradio", { name: "Top" })).toBeNull();
    expect(menu.queryByRole("menuitemradio", { name: "Bottom" })).toBeNull();
    expect(menu.queryByRole("menuitem", { name: "Undock" })).toBeNull();
    expect(menu.getByRole("menuitem", { name: "Close Surface" })).toBeVisible();
  });

  it("gives a docked surface no kebab or context menu and makes Shift+F10 a no-op", () => {
    render(
      <SurfaceTabs
        tabs={[
          TABS[0]!,
          {
            id: "browser",
            label: "Browser",
            icon: Globe,
            isCloseable: true,
            isSelected: true,
            isDocked: true,
            placement: "right",
            dockedDescription: "Docked right to Chat",
          },
        ]}
      />,
    );

    expect(tab("Browser")).toHaveAttribute("aria-selected", "true");
    expect(tab("Browser")).toHaveAttribute("aria-description", "Docked right to Chat");
    expect(screen.queryByRole("button", { name: "Switch docked surface" })).toBeNull();
    expect(tab("Browser").querySelector('[data-slot="docked-surface-switcher"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Browser surface options" })).toBeNull();
    fireEvent.contextMenu(tab("Browser"));
    expect(screen.queryByRole("menu", { name: "Browser surface options" })).toBeNull();
    fireEvent.keyDown(tab("Browser"), { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu", { name: "Browser surface options" })).toBeNull();
  });

  it("outlines the whole inactive dock group without changing its height", () => {
    render(
      <SurfaceTabs
        tabs={[
          {
            ...TABS[0]!,
            isSelected: false,
            isDocked: true,
            isVisuallyActive: false,
            joinedSide: "start",
          },
          {
            id: "browser",
            label: "Browser",
            icon: Globe,
            isCloseable: true,
            isDocked: true,
            isVisuallyActive: false,
            joinedSide: "end",
            placement: "right",
          },
          { id: "terminal", label: "Terminal", icon: Terminal, isSelected: true },
        ]}
      />,
    );

    const group = document.querySelector('[data-slot="docked-tab-group"]')!;
    expect(getComputedStyle(group).height).toBe("var(--conan-control-height)");
    expect(getComputedStyle(group).boxShadow).toContain("inset");
    expect(group.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });

  it("cycles the one visible dock slot through every docked surface", () => {
    const onSelect = vi.fn();
    render(
      <SurfaceTabs
        tabs={[
          TABS[0]!,
          {
            id: "browser",
            label: "Browser",
            icon: Globe,
            isCloseable: true,
            isDocked: true,
            placement: "right",
          },
          {
            id: "terminal",
            label: "Terminal",
            icon: Terminal,
            isCloseable: true,
            placement: "right",
          },
        ]}
        onSelect={onSelect}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Switch docked surface" })).toHaveLength(1);
    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(tab("Browser").querySelector('[data-slot="docked-surface-switcher"]')).toHaveStyle({
      backgroundImage: "",
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch docked surface" }));
    const switcher = screen.getByRole("menu", { name: "Switch docked surface" });
    expect(within(switcher).getByRole("menuitemradio", { name: "Browser" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(switcher).getByRole("menuitemradio", { name: "Terminal" }));
    expect(onSelect).toHaveBeenCalledWith("terminal");
  });

  it("offers every surface and disables only the ones already open", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const opener = screen.getByRole("button", { name: /Surface/ });
    expect(opener).toBeEnabled();
    fireEvent.click(opener);
    const menu = screen.getByRole("menu", { name: "Surface" });
    expect(within(menu).getByRole("menuitem", { name: "Browser" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: "Terminal" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("offers Sagan only when the active project has valid capability", () => {
    const { unmount } = render(<SurfaceTabs tabs={TABS} />);

    fireEvent.click(screen.getByRole("button", { name: "Surface" }));
    expect(
      within(screen.getByRole("menu", { name: "Surface" })).queryByRole("menuitem", {
        name: "Sagan",
      }),
    ).toBeNull();

    unmount();
    render(<SurfaceTabs tabs={TABS} saganAvailable />);
    fireEvent.click(screen.getByRole("button", { name: "Surface" }));
    expect(
      within(screen.getByRole("menu", { name: "Surface" })).getByRole("menuitem", {
        name: "Sagan",
      }),
    ).toBeVisible();
  });

  it("dims and disables Surface only after every surface is open", () => {
    render(
      <SurfaceTabs
        tabs={[
          ...TABS,
          { id: "terminal", label: "Terminal", icon: Terminal },
          { id: "files", label: "Files", icon: Diff },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Surface" })).toBeDisabled();
  });

});
