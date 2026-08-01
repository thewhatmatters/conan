import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import V2DiffView, { MAX_DIFF_ROWS, PREVIEW_ROWS } from "../components/V2DiffView.tsx";
import { buildFileDiff } from "../../lib/diff.ts";

describe("V2DiffView", () => {
  it("renders a degraded diff as counts only", () => {
    const diff = buildFileDiff("Write", {
      file_path: "/tmp/huge.bin",
      content: "x\u0000y",
    });
    expect(diff).not.toBeNull();
    expect(diff!.lines).toBeNull();

    render(<V2DiffView diff={diff!} />);
    expect(screen.getByText("/tmp/huge.bin")).toBeInTheDocument();
    expect(screen.getByText(/Binary content/)).toBeInTheDocument();
  });

  it("caps rendered rows at MAX_DIFF_ROWS even when expanded", () => {
    const content = Array.from({ length: MAX_DIFF_ROWS + 50 }, (_, i) => `row ${i + 1}`).join("\n");
    const diff = buildFileDiff("Write", { file_path: "/tmp/long.txt", content });
    expect(diff!.lines!.length).toBe(MAX_DIFF_ROWS + 50);

    render(<V2DiffView diff={diff!} />);
    fireEvent.click(screen.getByRole("button", { name: /Show full diff/ }));

    expect(screen.getByText(`row ${MAX_DIFF_ROWS}`)).toBeInTheDocument();
    expect(screen.queryByText(`row ${MAX_DIFF_ROWS + 1}`)).not.toBeInTheDocument();
    expect(screen.getByText(/50 more lines/)).toBeInTheDocument();
  });

  it("shows exactly the preview rows before expanding", () => {
    const content = Array.from({ length: 30 }, (_, i) => `p ${i + 1}`).join("\n");
    const diff = buildFileDiff("Write", { file_path: "/tmp/p.txt", content });

    render(<V2DiffView diff={diff!} />);
    expect(screen.getByText(`p ${PREVIEW_ROWS}`)).toBeInTheDocument();
    expect(screen.queryByText(`p ${PREVIEW_ROWS + 1}`)).not.toBeInTheDocument();
  });
});
