/**
 * BranchChip (p2c US-302) — Paper S5-0 node UX-0.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import BranchChip from "../chat/composer/BranchChip.tsx";

describe("BranchChip", () => {
  it("renders the branch name", () => {
    render(<BranchChip branch="loop/conan-v2-astryx" />);
    expect(screen.getByText("loop/conan-v2-astryx")).toBeInTheDocument();
  });

  it("renders nothing when the directory is not a repo", () => {
    const { container } = render(<BranchChip branch={null} />);
    expect(container.querySelector('[data-slot="branch-chip"]')).toBeNull();
  });

  it("keeps the dirty count out of the drawn label but in the a11y name", () => {
    render(<BranchChip branch="main" dirty={3} />);
    const chip = screen.getByLabelText("Branch main, 3 uncommitted");
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe("main");
  });

  it("omits the count from the a11y name on a clean tree", () => {
    render(<BranchChip branch="main" />);
    expect(screen.getByLabelText("Branch main")).toBeInTheDocument();
  });
});
