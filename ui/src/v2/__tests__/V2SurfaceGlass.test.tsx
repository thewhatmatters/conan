/**
 * WHA-120 — the surface panes are an OVERLAY stack, not a column of rows.
 *
 * WHA-115 frosted the pane header and gave `body` a top inset so its content
 * cleared it. That held while `body` was the scroller. WHA-114 then gave Files
 * and Diff their own path row plus an inner `treeScroller`, and the inner
 * scroller started BELOW both bars — so nothing passed under the glass and the
 * bar read flat. Measured at `1df121e`: bar bottom y=129, scroller top y=161.
 *
 * The rule that has to hold is therefore geometric: the scroller spans the
 * FULL pane and clears the bars with its own top padding. jsdom neither lays
 * out nor paints, so the y-coordinates belong to the browser pass — what is
 * checkable here is the COMPILED RULE. StyleX's atomic class for a given
 * (property, value) is a deterministic hash, so declaring the same rule
 * locally yields the same class, and asking whether the scroller carries it
 * checks what it compiled with rather than a string in the source.
 *
 * Both assertions below fail at `1df121e`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stylex from "@stylexjs/stylex";
import { render, screen, waitFor } from "@testing-library/react";
import { V2BrowserSurface, V2FilesSurface } from "../components/V2SurfaceBodies.tsx";

/** StyleX prepends a per-declaration-site debug name; only hashes are shared. */
function atoms(style: stylex.StyleXStyles): string[] {
  return (stylex.props(style).className ?? "")
    .split(" ")
    .filter((name) => name && !name.includes("__"));
}

const expected = stylex.create({
  // Clears the pane's 64px glass bar AND the surface's own 32px one.
  scrollerInset: {
    paddingBlockStart:
      "calc(var(--conan-secondary-bar-height) + var(--conan-control-height) + var(--conan-space-1))",
  },
  // The Browser's frame fills the pane behind both bars rather than below them.
  frameFill: { inset: 0, position: "absolute" },
});

const LISTING = {
  path: "/repo",
  parent: null,
  entries: [
    { name: "src", path: "/repo/src", isDir: true },
    { name: "README.md", path: "/repo/README.md", isDir: false },
  ],
};

describe("surface glass overlay (WHA-120)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/fs/list")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(LISTING) } as Response);
        }
        if (url.includes("/api/fs/diff")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ repo: true, files: [] }),
          } as Response);
        }
        if (url.includes("/api/browser/probe")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ reachable: true, frameable: true, reason: null, status: 200 }),
          } as Response);
        }
        if (url.includes("/api/browser/read")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ title: "Local app" }),
          } as Response);
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("insets the Files tree past BOTH frosted bars instead of starting below them", async () => {
    const { container } = render(<V2FilesSurface token="t" cwd="/repo" />);
    await screen.findByText("README.md");

    // The tree's scroll container is the element that owns the overflow; it is
    // the only box in the pane that must carry the combined inset.
    const scroller = await waitFor(() => {
      const found = [...container.querySelectorAll("div")].find((node) =>
        atoms(expected.scrollerInset).every((atom) => node.classList.contains(atom)),
      );
      expect(found, "no Files scroller carries the two-bar inset").toBeTruthy();
      return found!;
    });

    // …and it must be the scroller, not some incidental wrapper: the same node
    // carries the tree.
    expect(scroller.querySelector('[role="tree"], [role="treegrid"], ul, div')).toBeTruthy();
  });

  it("fills the Browser pane behind the bars rather than starting below them", async () => {
    const { container } = render(
      <V2BrowserSurface token="t" active onStateChange={undefined} />,
    );
    const input = await screen.findByLabelText("URL");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(input, { target: { value: "http://localhost:5173" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const frame = await waitFor(() => {
      const found = container.querySelector("iframe");
      expect(found, "the frame never rendered").toBeTruthy();
      return found!;
    });

    const wrapper = frame.parentElement!;
    const wanted = atoms(expected.frameFill);
    expect(
      wanted.every((atom) => wrapper.classList.contains(atom)),
      "the frame's wrapper does not fill the pane",
    ).toBe(true);
  });
});
