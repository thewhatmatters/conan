import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
  if (cmd === "browser_window_metrics") {
    return { scale_factor: 1, inner_width: 1400, inner_height: 900 };
  }
  if (cmd === "browser_state") return { url: null, open: false };
  return { url: null, open: true };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));
vi.mock("../../lib/gateway.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gateway.ts")>();
  return { ...actual, isTauri: () => true };
});

const { useNativeBrowser } = await import("../lib/useNativeBrowser.ts");

/** A rect the test can move underneath the hook, as docking does. */
let rect = { x: 290, y: 189, width: 1094, height: 663 };

function Harness({ url, visible }: { url: string | null; visible: boolean }) {
  const anchor = useRef<HTMLDivElement | null>(null);
  useNativeBrowser({ anchor, url, visible });
  return (
    <div
      ref={(node) => {
        anchor.current = node;
        if (node) {
          // A faithful DOMRect — the earlier stub left right/bottom at 0, which
          // silently broke every intersection test against it.
          node.getBoundingClientRect = () =>
            ({
              ...rect,
              top: rect.y,
              left: rect.x,
              right: rect.x + rect.width,
              bottom: rect.y + rect.height,
              toJSON: () => ({}),
            }) as DOMRect;
        }
      }}
    />
  );
}

function boundsCalls() {
  return invoke.mock.calls.filter(([cmd]) => cmd === "browser_set_bounds");
}

describe("useNativeBrowser geometry tracking", () => {
  beforeEach(() => {
    invoke.mockClear();
    rect = { x: 290, y: 189, width: 1094, height: 663 };
    // jsdom's viewport, so the measured chrome offset is 900 - 868 = 32.
    Object.defineProperty(window, "innerHeight", { value: 868, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1400, configurable: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("adds the measured window-chrome offset to y, not to x", async () => {
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    const [, args] = boundsCalls()[0] as [string, Record<string, number>];
    // The macOS titlebar: add_child measures from the window content area,
    // getBoundingClientRect from the webview viewport, 32px lower.
    expect(args.y).toBe(189 + 32);
    expect(args.x).toBe(290);
    expect(args.width).toBe(1094);
  });

  it("follows the rect when the pane is docked — the bug Randy hit", async () => {
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    invoke.mockClear();

    // Docking narrows the pane and moves it right. Nothing resizes the WINDOW
    // and React may keep the same node, so only a live re-read catches this —
    // the old ResizeObserver never even attached.
    rect = { x: 820, y: 189, width: 564, height: 663 };

    await waitFor(() => {
      const calls = boundsCalls();
      expect(calls.length).toBeGreaterThan(0);
      const [, args] = calls[calls.length - 1] as [string, Record<string, number>];
      expect(args.x).toBe(820);
      expect(args.width).toBe(564);
    });
  });

  it("hides the view when the pane collapses to zero area", async () => {
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    invoke.mockClear();

    rect = { x: 0, y: 0, width: 0, height: 0 };
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([cmd, args]) =>
            cmd === "browser_set_visible" && (args as { visible?: boolean } | undefined)?.visible === false,
        ),
      ).toBe(true),
    );
  });

  it("re-shows the view when the pane comes back", async () => {
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    rect = { x: 0, y: 0, width: 0, height: 0 };
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([cmd, args]) =>
            cmd === "browser_set_visible" && (args as { visible?: boolean } | undefined)?.visible === false,
        ),
      ).toBe(true),
    );
    invoke.mockClear();

    rect = { x: 820, y: 189, width: 564, height: 663 };
    // Without the explicit re-show, bounds alone would leave it invisible.
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([cmd, args]) =>
            cmd === "browser_set_visible" && (args as { visible?: boolean } | undefined)?.visible === true,
        ),
      ).toBe(true),
    );
  });

  it("hides the view when an overlay covers it — QA's product-blocking defect", async () => {
    // Confirmed live: ⌘K over a live browser opens and takes focus while being
    // invisible in pixels, because a native view composites above the whole
    // webview and no z-index reaches it. Hiding is the only lever.
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    invoke.mockClear();

    const palette = document.createElement("div");
    palette.setAttribute("data-slot", "command-palette");
    palette.getBoundingClientRect = () =>
      ({ x: 400, y: 300, width: 600, height: 400, left: 400, top: 300, right: 1000, bottom: 700, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(palette);

    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([cmd, args]) =>
            cmd === "browser_set_visible" &&
            (args as { visible?: boolean } | undefined)?.visible === false,
        ),
      ).toBe(true),
    );

    // ...and comes back when the overlay closes, or the browser is gone for good.
    invoke.mockClear();
    palette.remove();
    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([cmd, args]) =>
            cmd === "browser_set_visible" &&
            (args as { visible?: boolean } | undefined)?.visible === true,
        ),
      ).toBe(true),
    );
  });

  it("ignores an overlay that does not touch the view", async () => {
    // Blanket hide-on-any-overlay would blink the page away for the Surface and
    // Actions menus, which sit above the pane and never occlude it.
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    invoke.mockClear();

    const menu = document.createElement("div");
    menu.setAttribute("aria-modal", "true");
    // Entirely above the anchor (which starts at y=189).
    menu.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 200, height: 40, left: 0, top: 0, right: 200, bottom: 40, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(menu);

    // Give the loop several frames to get it wrong.
    await new Promise((r) => setTimeout(r, 120));
    expect(
      invoke.mock.calls.some(
        ([cmd, args]) =>
          cmd === "browser_set_visible" &&
          (args as { visible?: boolean } | undefined)?.visible === false,
      ),
    ).toBe(false);
    menu.remove();
  });

  it("catches a native Astryx dialog, not just the palette", async () => {
    render(<Harness url="https://example.com" visible />);
    await waitFor(() => expect(boundsCalls().length).toBeGreaterThan(0));
    invoke.mockClear();

    // Astryx's Dialog renders a real <dialog open aria-modal="true">, which is
    // why `[role="dialog"]` matches nothing and the selector targets the tag.
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    dialog.setAttribute("aria-modal", "true");
    dialog.getBoundingClientRect = () =>
      ({ x: 500, y: 300, width: 400, height: 200, left: 500, top: 300, right: 900, bottom: 500, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(dialog);

    await waitFor(() =>
      expect(
        invoke.mock.calls.some(
          ([cmd, args]) =>
            cmd === "browser_set_visible" &&
            (args as { visible?: boolean } | undefined)?.visible === false,
        ),
      ).toBe(true),
    );
    dialog.remove();
  });
});
