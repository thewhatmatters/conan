import { render, screen, within } from "@testing-library/react";
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

  it("renders chat when chat is the active surface", () => {
    render(
      <SurfaceWorkspace
        activeSurface="chat"
        openSurfaces={[]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Chat body")).toBeVisible();
    expect(document.querySelector('[data-slot="chat-surface"]')).toBeVisible();
    expect(document.querySelector('[data-surface]')).toBeNull();
  });

  it("renders the active non-chat surface full-pane", () => {
    render(
      <SurfaceWorkspace
        activeSurface="browser"
        openSurfaces={["browser"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Chat body")).not.toBeVisible();
    expect(document.querySelector('[data-slot="chat-surface"]')).not.toBeVisible();
    expect(document.querySelector('[data-surface="browser"]')).toBeVisible();
  });

  it("keeps inactive surfaces mounted but hidden", () => {
    render(
      <SurfaceWorkspace
        activeSurface="terminal"
        openSurfaces={["browser", "terminal"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(document.querySelector('[data-surface="browser"]')).not.toBeVisible();
    expect(document.querySelector('[data-surface="terminal"]')).toBeVisible();
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

  it("renders no workspace toolbar when Chat is the active surface", () => {
    render(
      <SurfaceWorkspace
        activeSurface="chat"
        openSurfaces={["terminal"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(document.querySelector('[data-slot="surface-pane-header"]')).toBeNull();
    expect(document.querySelector('[data-slot="surface-toolbar"]')).toBeNull();
  });

  it("renders a glass header with the surface name on the left for non-chat surfaces", () => {
    render(
      <SurfaceWorkspace
        activeSurface="terminal"
        openSurfaces={["terminal"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    const header = document.querySelector('[data-slot="surface-pane-header"]');
    expect(header).not.toBeNull();

    const toolbar = document.querySelector('[data-slot="surface-toolbar"]');
    expect(toolbar).not.toBeNull();

    const label = within(toolbar as HTMLElement).getByText("Terminal");
    expect(label).toBeVisible();
    expect(label.closest('[data-slot="surface-toolbar-left"]')).not.toBeNull();
  });

  it("updates the toolbar label when the active surface changes", () => {
    const { rerender } = render(
      <SurfaceWorkspace
        activeSurface="browser"
        openSurfaces={["browser", "terminal"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Browser")).toBeVisible();

    rerender(
      <SurfaceWorkspace
        activeSurface="terminal"
        openSurfaces={["browser", "terminal"]}
        token={null}
        cwd={null}
      >
        <div>Chat body</div>
      </SurfaceWorkspace>,
    );

    expect(screen.getByText("Terminal")).toBeVisible();
    expect(screen.queryByText("Browser")).toBeNull();
  });
});
