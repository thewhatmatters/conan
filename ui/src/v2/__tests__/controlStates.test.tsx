/**
 * WHA-203 — the v2 control state model, asserted across components.
 *
 * The bug these guard is not "a button looks wrong in isolation"; it is two
 * controls in the same 32px rail disagreeing. At `12aa3d3` the sort trigger
 * rested at `--conan-icon-primary` in a 28×28 / 10px-radius Astryx ghost and
 * the add-project control at `--conan-icon-muted` in a 32×32 / 4px-radius
 * hand-rolled button, with no hover, press, or focus response on either.
 *
 * So the assertions are deliberately CROSS-COMPONENT: they compare the two
 * controls to each other, not to a hard-coded expectation, which is the only
 * shape that fails when someone restyles one of them alone.
 *
 * jsdom resolves the default branch of a StyleX conditional and reports the
 * `var(...)` reference rather than a resolved colour — so hover and press are
 * verified in the browser probe (`.scratch/wha203-states.mjs`), not here.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProjectTree from "../components/ProjectTree.tsx";
import ProjectSortMenu from "../components/ProjectSortMenu.tsx";

const rest = (el: Element) => {
  const s = window.getComputedStyle(el);
  return {
    color: s.color,
    borderRadius: s.borderRadius,
    width: s.width,
    height: s.height,
  };
};

describe("v2 control state model", () => {
  it("rests both header controls on the same colour, radius and lane", () => {
    render(
      <ProjectTree
        groups={[]}
        onAddProject={() => {}}
        sortMenu={
          <ProjectSortMenu
            projectOrder="lastActivity"
            threadOrder="lastActivity"
            projectCount={2}
          />
        }
      />,
    );

    const add = rest(screen.getByRole("button", { name: "Add project" }));
    const sort = rest(screen.getByRole("button", { name: "Sort projects" }));

    expect(add).toEqual(sort);
    // Pinned so "they match" cannot be satisfied by both drifting together.
    expect(add.color).toBe("var(--conan-icon-muted)");
    expect(add.borderRadius).toBe("var(--conan-radius-sm)");
    expect(add.height).toBe("var(--conan-control-height)");
  });

  it("draws a disabled control as inert rather than just unclickable", () => {
    // No `onAddProject` and no `sortMenu`: both controls fall to disabled.
    render(<ProjectTree groups={[]} />);

    for (const name of ["Add project", "Sort projects"]) {
      const el = screen.getByRole("button", { name });
      const style = window.getComputedStyle(el);
      expect(el).toBeDisabled();
      expect(style.opacity).toBe("0.4");
      expect(style.cursor).toBe("default");
    }
  });

  it("keeps the trigger lit while its own menu is open", () => {
    render(
      <ProjectSortMenu
        projectOrder="lastActivity"
        threadOrder="lastActivity"
        projectCount={2}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Sort projects" });
    const before = window.getComputedStyle(trigger).backgroundColor;

    fireEvent.click(trigger);

    const after = window.getComputedStyle(trigger).backgroundColor;
    expect(after).not.toBe(before);
    expect(after).toBe("var(--conan-wash-hover)");
  });
});
