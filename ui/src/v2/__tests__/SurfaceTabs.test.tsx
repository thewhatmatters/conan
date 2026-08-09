/**
 * SurfaceTabs — Paper RJ-0 node HL-0.
 *
 * WHA-156 turns the strip into Astryx's single-select ToggleButtonGroup. These
 * tests pin its pressed semantics, equal sizing, persistent selection, and the
 * existing surface menus/docking behaviour around it.
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

const toggleNames = () =>
  within(screen.getByRole("group", { name: "Chat and surfaces" }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

const toggle = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}$`) });

describe("SurfaceTabs", () => {
  it("is a labelled Astryx toggle group in the artboard's order", () => {
    render(<SurfaceTabs />);

    const group = screen.getByRole("group", { name: "Chat and surfaces" });
    expect(group).toBeInTheDocument();
    expect(toggleNames()).toEqual(["Chat"]);
    expect(group).toContainElement(toggle("Chat"));
  });

  it("marks exactly the selected surface pressed", () => {
    render(<SurfaceTabs tabs={TABS} />);

    expect(toggle("Chat")).toHaveAttribute("aria-pressed", "true");
    expect(toggle("Browser")).toHaveAttribute("aria-pressed", "false");
    expect(toggle("Diff")).toHaveAttribute("aria-pressed", "false");
  });

  it("sizes every mode to its content", () => {
    render(<SurfaceTabs tabs={TABS} />);

    for (const label of ["Chat", "Browser", "Diff"]) {
      expect(getComputedStyle(toggle(label)).width).toBe("fit-content");
    }
  });

  it("centers icons eight pixels from their labels", () => {
    render(<SurfaceTabs tabs={TABS} />);

    for (const label of ["Chat", "Browser", "Diff"]) {
      const labelRow = toggle(label).querySelector('[data-slot="surface-tab-label"]');
      expect(labelRow).not.toBeNull();
      expect(getComputedStyle(labelRow!).columnGap).toBe("var(--conan-space-2)");
      expect(getComputedStyle(labelRow!).justifyContent).toBe("center");
      expect(getComputedStyle(labelRow!).top).toBe("var(--conan-space-hair)");
      expect(getComputedStyle(labelRow!).whiteSpace).toBe("nowrap");
    }
  });

  it("keeps every mode keyboard focusable as a native button", () => {
    render(<SurfaceTabs tabs={TABS} />);

    for (const label of ["Chat", "Browser", "Diff"]) {
      toggle(label).focus();
      expect(toggle(label)).toHaveFocus();
    }
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

    expect(toggle("Chat").querySelector("button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Close Chat tab" }),
    ).not.toBeInTheDocument();
  });

  it("reports a new mode and ignores active-mode deselection", () => {
    const onSelect = vi.fn();
    render(<SurfaceTabs tabs={TABS} onSelect={onSelect} />);

    fireEvent.click(toggle("Browser"));
    fireEvent.click(toggle("Chat"));

    expect(onSelect).toHaveBeenCalledTimes(1);
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
          { ...TABS[0]!, isSelected: false },
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

    expect(toggle("Browser")).toHaveAttribute("aria-pressed", "true");
    expect(toggle("Browser")).toHaveAttribute("aria-description", "Docked right to Chat");
    expect(screen.queryByRole("button", { name: "Switch docked surface" })).toBeNull();
    expect(toggle("Browser").querySelector('[data-slot="docked-surface-switcher"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Browser surface options" })).toBeNull();
    fireEvent.contextMenu(toggle("Browser"));
    expect(screen.queryByRole("menu", { name: "Browser surface options" })).toBeNull();
    fireEvent.keyDown(toggle("Browser"), { key: "F10", shiftKey: true });
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
    expect(group.querySelectorAll('[data-slot="surface-tab"]')).toHaveLength(2);
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
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(toggle("Browser").closest('[data-slot="surface-tab-shell"]')?.querySelector(
      '[data-slot="docked-surface-switcher"]',
    )).toHaveStyle({
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
