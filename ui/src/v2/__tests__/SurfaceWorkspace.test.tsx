import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SurfaceWorkspace from "../components/SurfaceWorkspace.tsx";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";

describe("SurfaceWorkspace", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1920,
      height: 1000,
      top: 0,
      right: 1920,
      bottom: 1000,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  it("opens a new surface as a full-workspace tab until placement is chosen", () => {
    render(
      <SurfaceWorkspace
        header={<div>Chat header</div>}
        activeSurface="browser"
        openSurfaces={["browser"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Chat body").closest('[data-slot="chat-surface"]')).not.toBeVisible();
    expect(document.querySelector('[data-slot="surface-dock"]')).toHaveAttribute(
      "data-placement",
      "tab",
    );
    expect(document.querySelector('[role="separator"]')).not.toBeVisible();
  });

  it("docks to Chat only after placement and reports the real 60% bound", async () => {
    render(
      <SurfaceWorkspace
        header={<div>Chat header</div>}
        activeSurface="browser"
        openSurfaces={["browser"]}
        placement="right"
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Chat body").closest('[data-slot="chat-surface"]')).toBeVisible();
    const separator = screen.getByRole("separator", { name: "Resize surface" });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuemax", "1152"));

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "1152");
  });

  it("gives the docked pane a matching header with an explicit Undock action", () => {
    const onUndock = vi.fn();
    render(
      <SurfaceWorkspace
        header={<div>Chat actions</div>}
        activeSurface="diff"
        openSurfaces={["diff"]}
        placement="right"
        token={null}
        cwd={null}
        onUndock={onUndock}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Chat actions")).toBeVisible();
    expect(document.querySelector('[data-slot="docked-surface-header"]')).toHaveTextContent(
      "Diff",
    );
    expect(document.querySelector('[data-slot="surface-header-rule"]')).toBeVisible();
    const undock = screen.getByRole("button", { name: "Undock Diff" });
    expect(undock).toHaveAttribute("title", "Undock Diff");
    fireEvent.click(undock);
    expect(onUndock).toHaveBeenCalledWith("diff");
  });

  it("orders a left dock, splitter, and Chat at the pane boundary", () => {
    render(
      <SurfaceWorkspace
        header={<div>Chat actions</div>}
        activeSurface="browser"
        openSurfaces={["browser"]}
        placement="left"
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(getComputedStyle(document.querySelector('[data-slot="surface-dock"]')!).order).toBe(
      "-2",
    );
    expect(getComputedStyle(screen.getByRole("separator")).order).toBe("-1");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical");
  });

  it("keeps Sagan mounted across thread changes", async () => {
    const sagan = {
      available: true,
      projectPath: "/repo/sagan",
      status: "ready" as const,
      error: null,
      updatedAt: Date.now(),
      data: {
        project: { sagan: { state: "valid" } },
        runs: [],
      },
    } as unknown as SaganCapabilityResult;
    const { rerender } = render(
      <SurfaceWorkspace
        header={<div>Chat actions</div>}
        activeSurface="sagan"
        openSurfaces={["sagan"]}
        token="tok"
        cwd="/repo/sagan"
        sagan={sagan}
      >
        <div>Thread one</div>
      </SurfaceWorkspace>,
    );

    const surface = document.querySelector('[data-surface="sagan"]');
    // WHA-144 — the Sagan surface's header is a tab strip now (Overview /
    // Pipeline), and Astryx's Tab renders its label twice (the second copy is
    // aria-hidden, sizing the tab for its own bold state).
    expect(await screen.findByRole("button", { name: "Overview" })).toBeVisible();

    rerender(
      <SurfaceWorkspace
        header={<div>Chat actions</div>}
        activeSurface="sagan"
        openSurfaces={["sagan"]}
        token="tok"
        cwd="/repo/sagan"
        sagan={sagan}
      >
        <div>Thread two</div>
      </SurfaceWorkspace>,
    );
    expect(document.querySelector('[data-surface="sagan"]')).toBe(surface);

    rerender(
      <SurfaceWorkspace
        header={<div>Chat actions</div>}
        activeSurface="sagan"
        openSurfaces={["sagan"]}
        token="tok"
        cwd="/repo/other"
        sagan={{ ...sagan, projectPath: "/repo/other" }}
      >
        <div>Thread three</div>
      </SurfaceWorkspace>,
    );
    expect(document.querySelector('[data-surface="sagan"]')).toBe(surface);
  });
});
