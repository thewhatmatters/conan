/**
 * ProjectTree dense-list behaviour — WHA-87.
 *
 * Randy, 2026-08-02: "Let's collapse and show 'more' if there's a considerable
 * amount of threads." A project with a handful of threads must render exactly
 * as it did before — the control only appears once a list is long enough to
 * turn the sidebar into a log file.
 *
 * The threshold is asserted against the exported constant rather than a literal
 * 8, so tuning it stays the one-line change it was designed to be.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ProjectTree, {
  THREAD_COLLAPSE_THRESHOLD,
  type ProjectGroup,
} from "../components/ProjectTree.tsx";

function groupOf(threadCount: number): ProjectGroup[] {
  return [
    {
      id: "conan",
      name: "Conan",
      isExpanded: true,
      threads: Array.from({ length: threadCount }, (_, index) => ({
        id: `t${index}`,
        title: `Thread ${index}`,
        subtitle: "…",
      })),
    },
  ];
}

const rows = (container: HTMLElement) =>
  container.querySelectorAll('[data-slot="thread-row"]');

describe("ProjectTree dense lists", () => {
  it("shows every thread and no control at the threshold", () => {
    const { container } = render(
      <ProjectTree groups={groupOf(THREAD_COLLAPSE_THRESHOLD)} />,
    );

    expect(rows(container)).toHaveLength(THREAD_COLLAPSE_THRESHOLD);
    expect(
      container.querySelector('[data-slot="thread-show-more"]'),
    ).toBeNull();
  });

  it("collapses one past the threshold and says how many are hidden", () => {
    const total = THREAD_COLLAPSE_THRESHOLD + 12;
    const { container } = render(<ProjectTree groups={groupOf(total)} />);

    expect(rows(container)).toHaveLength(THREAD_COLLAPSE_THRESHOLD);
    const more = screen.getByRole("button", {
      name: `Show 12 more threads in Conan`,
    });
    expect(more).toHaveTextContent("Show 12 more");
  });

  it("singularizes the label when exactly one thread is hidden", () => {
    render(<ProjectTree groups={groupOf(THREAD_COLLAPSE_THRESHOLD + 1)} />);

    expect(
      screen.getByRole("button", { name: "Show 1 more thread in Conan" }),
    ).toBeInTheDocument();
  });

  it("reveals the rest and retires the control", () => {
    const total = THREAD_COLLAPSE_THRESHOLD + 12;
    const { container } = render(<ProjectTree groups={groupOf(total)} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Show 12 more threads in Conan" }),
    );

    expect(rows(container)).toHaveLength(total);
    expect(
      container.querySelector('[data-slot="thread-show-more"]'),
    ).toBeNull();
  });

  it("leaves a collapsed group alone — nothing renders until it is expanded", () => {
    const groups = groupOf(THREAD_COLLAPSE_THRESHOLD + 5).map((group) => ({
      ...group,
      isExpanded: false,
    }));
    const { container } = render(<ProjectTree groups={groups} />);

    expect(rows(container)).toHaveLength(0);
    expect(
      container.querySelector('[data-slot="thread-show-more"]'),
    ).toBeNull();
  });
});
