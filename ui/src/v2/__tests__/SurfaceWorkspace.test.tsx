import { fireEvent, render, screen, within } from "@testing-library/react";
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
    if (typeof globalThis.PointerEvent === "undefined") {
      globalThis.PointerEvent = class PointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      } as unknown as typeof PointerEvent;
    }
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
    expect(document.querySelector('[data-slot="surface-pane"]')).toBeNull();
    expect(document.querySelector('[data-slot="surface-splitter"]')).toBeNull();
  });

  it("renders the active non-chat surface beside chat", () => {
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

    expect(screen.getByText("Chat body")).toBeVisible();
    expect(document.querySelector('[data-slot="chat-surface"]')).toBeVisible();
    expect(document.querySelector('[data-slot="surface-pane"]')).toBeVisible();
    expect(document.querySelector('[data-surface="browser"]')).toBeVisible();
    expect(
      document.querySelector('[data-slot="surface-splitter"]'),
    ).toBeVisible();
  });

  it("renders only the active surface in the side pane", () => {
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

    expect(document.querySelector('[data-surface="terminal"]')).toBeVisible();
    expect(document.querySelector('[data-surface="browser"]')).toBeNull();
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

    const pane = document.querySelector('[data-slot="surface-pane"]') as HTMLElement;
    expect(pane).not.toBeNull();

    const header = pane.querySelector('[data-slot="surface-pane-header"]');
    expect(header).not.toBeNull();

    const toolbar = pane.querySelector('[data-slot="surface-toolbar"]');
    expect(toolbar).not.toBeNull();

    const label = within(toolbar as HTMLElement).getByText("Terminal");
    expect(label).toBeVisible();
    expect(label.closest('[data-slot="surface-toolbar-label"]')).not.toBeNull();
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

  it("drags the splitter to update the surface pane basis", () => {
    const proto = HTMLElement.prototype as any;
    if (typeof proto.setPointerCapture !== "function") {
      proto.setPointerCapture = () => {};
      proto.releasePointerCapture = () => {};
    }
    const setPointerCapture = vi.spyOn(proto, "setPointerCapture").mockImplementation(() => {});
    const releasePointerCapture = vi.spyOn(proto, "releasePointerCapture").mockImplementation(() => {});

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

    const splitter = document.querySelector('[data-slot="surface-splitter"]') as HTMLElement;
    const root = document.querySelector('[data-slot="surface-workspace"]') as HTMLElement;
    expect(splitter).not.toBeNull();

    fireEvent.pointerDown(splitter, { clientX: 1000, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 1200, clientY: 500, pointerId: 1 });

    const basis = root.style.getPropertyValue("--surface-basis");
    expect(basis).not.toBe("");
    expect(Number.parseFloat(basis)).toBeGreaterThan(40);

    fireEvent.pointerUp(splitter, { clientX: 1200, clientY: 500, pointerId: 1 });
    expect(releasePointerCapture).toHaveBeenCalledWith(1);

    setPointerCapture.mockRestore();
    releasePointerCapture.mockRestore();
  });
});
