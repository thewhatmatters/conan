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
          node.getBoundingClientRect = () =>
            ({ ...rect, top: rect.y, left: rect.x, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
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
});
