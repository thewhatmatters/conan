/**
 * ProjectSortMenu — Paper `73D-0`, WHA-60.
 *
 * These assert the two things a checkmark-shaped picture can get wrong:
 *
 * - The rows are `menuitemradio` with real `aria-checked`, not action rows
 *   wearing a tick. A screen reader has to hear the selection the artboard
 *   draws, and exactly one option per group can be checked.
 * - The two groups are INDEPENDENT. `Last Activity` and `Name` appear in both;
 *   the bug this guards is one group's selection following the other's because
 *   the option values collide.
 *
 * Also pinned: the surface orders and does not filter. `73D-0` is named
 * "Filtering" and contains no filter, so a future reader "restoring" one has to
 * delete an assertion that says so (WHA-78 owns that design).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProjectSortMenu from "../components/ProjectSortMenu.tsx";

function open(props: Partial<React.ComponentProps<typeof ProjectSortMenu>> = {}) {
  const view = render(
    <ProjectSortMenu
      projectOrder="lastActivity"
      threadOrder="lastActivity"
      projectCount={2}
      {...props}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: (props.projectCount ?? 2) > 1 ? "Sort projects" : "Sort threads",
    }),
  );
  return view;
}

describe("ProjectSortMenu", () => {
  it("mounts in the section header's action lane", () => {
    const { container } = render(
      <ProjectSortMenu
        projectOrder="lastActivity"
        threadOrder="lastActivity"
        projectCount={2}
      />,
    );

    expect(container.querySelector('[data-slot="project-sort"]')).not.toBeNull();
  });

  // Randy, 2026-08-17: one project has nothing to order against.
  it.each([0, 1])(
    "drops the project group — and the rows in it — with %i project(s)",
    (projectCount) => {
      open({ projectCount });

      expect(
        screen.queryByRole("group", { name: "Order Projects By" }),
      ).toBeNull();
      expect(screen.queryByText("Order Projects By")).toBeNull();
      // The rows themselves are gone, not merely unlabelled: four options
      // remain, and they are the thread set.
      expect(
        screen.getAllByRole("menuitemradio").map((row) => row.textContent?.trim()),
      ).toEqual(["Agent", "Last Activity", "Name", "Recently Added"]);
    },
  );

  it("keeps ordering threads when the project group is gone", () => {
    const onThreadOrderChange = vi.fn();
    open({ projectCount: 1, onThreadOrderChange });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));

    expect(onThreadOrderChange).toHaveBeenCalledWith("name");
  });

  it("names the trigger for what the menu offers", () => {
    const { unmount } = render(
      <ProjectSortMenu
        projectOrder="lastActivity"
        threadOrder="lastActivity"
        projectCount={1}
      />,
    );
    expect(screen.getByRole("button", { name: "Sort threads" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort projects" })).toBeNull();
    unmount();

    render(
      <ProjectSortMenu
        projectOrder="lastActivity"
        threadOrder="lastActivity"
        projectCount={2}
      />,
    );
    expect(screen.getByRole("button", { name: "Sort projects" })).toBeInTheDocument();
  });

  it("draws both of 73D-0's groups, named by their visible titles", () => {
    open();

    expect(
      screen.getByRole("group", { name: "Order Projects By" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Order Threads By" }),
    ).toBeInTheDocument();
  });

  it("offers exactly the options 73D-0 draws, in its order", () => {
    open();

    const labels = (name: string) =>
      Array.from(
        screen
          .getByRole("group", { name })
          .querySelectorAll('[role="menuitemradio"]'),
      ).map((row) => row.textContent?.trim());

    expect(labels("Order Projects By")).toEqual([
      "Last Activity",
      "Name",
      "Recently Added",
    ]);
    expect(labels("Order Threads By")).toEqual([
      "Agent",
      "Last Activity",
      "Name",
      "Recently Added",
    ]);
  });

  it("announces the active option as checked, one per group", () => {
    open({ projectOrder: "name", threadOrder: "agent" });

    const checked = (name: string) =>
      Array.from(
        screen
          .getByRole("group", { name })
          .querySelectorAll('[aria-checked="true"]'),
      ).map((row) => row.textContent?.trim());

    expect(checked("Order Projects By")).toEqual(["Name"]);
    expect(checked("Order Threads By")).toEqual(["Agent"]);
  });

  it("draws the checkmark on the active row, and only there", () => {
    // `aria-checked` is Astryx's; the visible tick is 73D-0's. Asserting the
    // former alone passes with no mark drawn at all, which is the one thing a
    // reader of the artboard would notice immediately.
    open({ projectOrder: "name", threadOrder: "agent" });

    const marked = (name: string) =>
      Array.from(
        screen
          .getByRole("group", { name })
          .querySelectorAll('[role="menuitemradio"]'),
      )
        .filter((row) => row.querySelector('[data-slot="order-check"]'))
        .map((row) => row.textContent?.trim());

    expect(marked("Order Projects By")).toEqual(["Name"]);
    expect(marked("Order Threads By")).toEqual(["Agent"]);
  });

  it("keeps the two groups independent when an option name appears in both", () => {
    // "Last Activity" and "Name" exist in both groups. If the groups shared
    // selection state, setting one would tick the other's row of the same name.
    open({ projectOrder: "name", threadOrder: "lastActivity" });

    const threads = screen.getByRole("group", { name: "Order Threads By" });
    const threadName = Array.from(
      threads.querySelectorAll('[role="menuitemradio"]'),
    ).find((row) => row.textContent?.trim() === "Name");

    expect(threadName).toHaveAttribute("aria-checked", "false");
  });

  it("reports the picked project order", () => {
    const onProjectOrderChange = vi.fn();
    open({ onProjectOrderChange });

    fireEvent.click(
      screen
        .getByRole("group", { name: "Order Projects By" })
        .querySelectorAll('[role="menuitemradio"]')[2]!,
    );

    expect(onProjectOrderChange).toHaveBeenCalledWith("recentlyAdded");
  });

  it("reports the picked thread order", () => {
    const onThreadOrderChange = vi.fn();
    open({ onThreadOrderChange });

    fireEvent.click(
      screen
        .getByRole("group", { name: "Order Threads By" })
        .querySelectorAll('[role="menuitemradio"]')[0]!,
    );

    expect(onThreadOrderChange).toHaveBeenCalledWith("agent");
  });

  it("orders only — 73D-0 draws no filter despite its name", () => {
    open();

    // Absence assertions pass vacuously against a menu that never opened, so
    // prove it is open before asserting what is not in it.
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(7);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
    for (const word of ["Filter", "Group", "Reset", "Repository"]) {
      expect(screen.queryByText(new RegExp(word, "i"))).not.toBeInTheDocument();
    }
  });
});
