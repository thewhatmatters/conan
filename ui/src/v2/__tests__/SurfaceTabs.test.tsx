/**
 * SurfaceTabs — Paper 2SJ-0 tab strip.
 *
 * WHA-158 turns the strip into a simple tab bar: permanent Chat tab,
 * closeable opened-surface tabs, and a Surface opener dropdown. No docking,
 * no placement menus.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Diff, Globe, MessagesSquare, Terminal } from "lucide-react";
import SurfaceTabs, { type SurfaceTab } from "../components/SurfaceTabs.tsx";

/** A three-tab strip: one permanent + two closeable, as 2SJ-0 has it. */
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

  it("draws the selected pill on the tab shell, not the toggle button", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const browserToggle = toggle("Browser");
    const browserShell = browserToggle.closest('[data-slot="surface-tab-shell"]');
    expect(browserShell).not.toBeNull();

    // The toggle button itself is transparent so the shell is the visual pill.
    expect(getComputedStyle(browserToggle).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("draws the selected pill behind the permanent Chat tab too", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const chatToggle = toggle("Chat");
    const chatShell = chatToggle.closest('[data-slot="surface-tab-shell"]');
    expect(chatShell).not.toBeNull();
    expect(getComputedStyle(chatShell!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps the close button inside the tab shell", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const closeButton = screen.getByRole("button", { name: "Close Browser tab" });
    expect(closeButton.closest('[data-slot="surface-tab-shell"]')).not.toBeNull();
  });

  it("pads the close button horizontally and sizes the reveal to match", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const browserToggle = toggle("Browser");
    const shell = browserToggle.closest('[data-slot="surface-tab-shell"]')!;
    const actions = shell.querySelector('[data-slot="surface-tab-actions"]')!;
    const closeButton = screen.getByRole("button", { name: "Close Browser tab" });

    fireEvent.mouseEnter(shell);

    expect(getComputedStyle(closeButton).paddingInline).toBe("var(--conan-space-1)");
    expect(getComputedStyle(actions).width).toBe(
      "calc(var(--conan-icon-size) + var(--conan-space-1) * 2)",
    );
  });

  it("paints a dark opaque segment behind the ✕ via the actions area", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const browserToggle = toggle("Browser");
    const shell = browserToggle.closest('[data-slot="surface-tab-shell"]')!;
    const actions = shell.querySelector('[data-slot="surface-tab-actions"]')!;

    // The dark fill is a static StyleX class; the width transition reveals it.
    expect(getComputedStyle(actions).backgroundColor).toBe("var(--conan-color-content)");
  });

  it("paints a hover pill behind the ✕ on unselected tabs", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const browserToggle = toggle("Browser");
    const browserShell = browserToggle.closest('[data-slot="surface-tab-shell"]')!;

    expect(getComputedStyle(browserShell).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    fireEvent.mouseEnter(browserShell);

    expect(getComputedStyle(browserShell).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps the selected wash on selected tabs during hover", () => {
    render(<SurfaceTabs tabs={TABS} />);

    const chatToggle = toggle("Chat");
    const chatShell = chatToggle.closest('[data-slot="surface-tab-shell"]')!;

    fireEvent.mouseEnter(chatShell);

    expect(getComputedStyle(chatShell).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
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

  it("draws a close button on closeable tabs, not on Chat", () => {
    render(<SurfaceTabs tabs={TABS} />);

    expect(toggle("Chat").querySelector('[data-slot="surface-tab-close"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Close Browser tab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Diff tab" })).toBeInTheDocument();
  });

  it("closes a tab from its close button without selecting it", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<SurfaceTabs tabs={TABS} onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close Browser tab" }));

    expect(onClose).toHaveBeenCalledWith("browser");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reports a new mode and ignores active-mode deselection", () => {
    const onSelect = vi.fn();
    render(<SurfaceTabs tabs={TABS} onSelect={onSelect} />);

    fireEvent.click(toggle("Browser"));
    fireEvent.click(toggle("Chat"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith("browser");
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
