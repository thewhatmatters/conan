/**
 * ThreadRow trailing slot + row menu — WHA-87 / WHA-103 / WHA-199.
 *
 * The trailing lane holds ONE slot with TWO occupants: a relative timestamp at
 * rest, the kebab on hover/focus (WHA-87, restored by WHA-199). The kebab is a
 * click `DropdownMenu` (project-row pattern). Right-click on the row still opens
 * a `ContextMenu` (WHA-103) — same items, second gesture.
 *
 * What these tests can honestly assert is the markup contract and the pure
 * logic — what "2d ago" resolves to, that the label carries the absolute
 * datetime, and that both gestures reach a menu. Paint and layout are not
 * asserted here: jsdom neither lays out nor paints, so those belong to the
 * browser pass.
 */
import { describe, expect, it, vi } from "vitest";
import * as stylex from "@stylexjs/stylex";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ThreadRow from "../components/ThreadRow.tsx";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "../lib/relativeTime.ts";

const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("renders the artboard's narrow shape", () => {
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe("2d ago");
    expect(formatRelativeTime(NOW - 1 * HOUR, NOW)).toBe("1h ago");
    expect(formatRelativeTime(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
  });

  it("collapses anything under a minute to 'now'", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("now");
    expect(formatRelativeTime(NOW, NOW)).toBe("now");
  });

  it("never reports activity in the future", () => {
    // The gateway's clock can run ahead of the renderer's; "in 3s ago" is a bug
    // on screen, so a future stamp reads as "now".
    expect(formatRelativeTime(NOW + 10 * MINUTE, NOW)).toBe("now");
  });

  it("steps up to months and years rather than counting 400 days", () => {
    expect(formatRelativeTime(NOW - 45 * DAY, NOW)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe("1y ago");
  });

  it("returns empty for a non-finite stamp instead of 'NaN ago'", () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe("");
  });
});

describe("ThreadRow trailing slot", () => {
  it("renders the relative timestamp inside the trailing slot", () => {
    const { container } = render(
      <ThreadRow
        title="Analyze my project"
        subtitle="Run serverless code..."
        lastActivity={NOW - 2 * DAY}
      />,
    );

    const slot = container.querySelector('[data-slot="thread-trailing"]');
    const stamp = container.querySelector('[data-slot="thread-timestamp"]');
    expect(slot).not.toBeNull();
    expect(stamp).not.toBeNull();
    expect(slot?.contains(stamp!)).toBe(true);
  });

  it("keeps '2d ago' honest with a machine and a human absolute time", () => {
    const at = NOW - 2 * DAY;
    const { container } = render(
      <ThreadRow title="Analyze" subtitle="..." lastActivity={at} />,
    );

    const stamp = container.querySelector('[data-slot="thread-timestamp"]');
    expect(stamp?.tagName).toBe("TIME");
    expect(stamp).toHaveAttribute("datetime", new Date(at).toISOString());
    expect(stamp).toHaveAttribute("title", formatAbsoluteTime(at));
  });

  it("omits the timestamp for a thread with no activity yet (drafts)", () => {
    const { container } = render(<ThreadRow title="Untitled" subtitle="..." />);

    expect(container.querySelector('[data-slot="thread-timestamp"]')).toBeNull();
    // The slot itself still renders — it is what reserves the lane.
    expect(container.querySelector('[data-slot="thread-trailing"]')).not.toBeNull();
  });

  it("puts the kebab in the same slot as the timestamp (WHA-199)", () => {
    const { container } = render(
      <ThreadRow
        title="Analyze"
        subtitle="..."
        lastActivity={NOW - DAY}
        onNewThread={() => {}}
      />,
    );

    const slot = container.querySelector('[data-slot="thread-trailing"]');
    const actions = container.querySelector('[data-slot="thread-actions"]');
    const stamp = container.querySelector('[data-slot="thread-timestamp"]');
    expect(slot?.contains(actions!)).toBe(true);
    expect(slot?.contains(stamp!)).toBe(true);
  });

  it("keeps the kebab reachable — it is a real button, not a hover-only node", () => {
    render(
      <ThreadRow
        title="Analyze"
        subtitle="..."
        lastActivity={NOW - DAY}
        onNewThread={() => {}}
      />,
    );

    const kebab = screen.getByRole("button", { name: "Actions for Analyze" });
    kebab.focus();
    expect(document.activeElement).toBe(kebab);
  });

  it("opens the click DropdownMenu from the kebab (project pattern)", async () => {
    render(
      <ThreadRow
        title="Analyze"
        subtitle="..."
        lastActivity={NOW - DAY}
        onNewThread={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions for Analyze" }));

    expect(screen.getByRole("menu", { name: "Actions for Analyze" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "New thread" })).toHaveFocus(),
    );
  });

  it("opens the menu on a right-click anywhere on the row", async () => {
    render(
      <ThreadRow
        title="Analyze"
        subtitle="..."
        lastActivity={NOW - DAY}
        onNewThread={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Analyze: ..." }));

    expect(screen.getByRole("menu", { name: "Actions for Analyze" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "New thread" })).toHaveFocus(),
    );
  });

  it("keeps left-click as selection, not as the menu", () => {
    const onSelect = vi.fn();
    render(
      <ThreadRow
        title="Analyze"
        subtitle="..."
        lastActivity={NOW - DAY}
        onSelect={onSelect}
        onNewThread={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Analyze: ..." }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    // "…and the menu did not open" is NOT asserted here: Astryx keeps the menu
    // markup mounted and hides it through the popover layer, which jsdom does
    // not implement — `queryByRole("menu")` finds the closed menu too. That
    // half belongs to the browser pass.
  });

  it("gives a handler-less placeholder row no menu at all", () => {
    render(<ThreadRow title="Analyze" subtitle="..." />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Analyze: ..." }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for Analyze" })).not.toBeInTheDocument();
  });

  /**
   * WHA-118 — the select button must state the shell's own focus ring.
   *
   * jsdom neither lays out nor paints and the StyleX plugin injects no CSS into
   * the test document, so `getComputedStyle(...).outline` reads empty here and
   * cannot be the assertion. What IS available is StyleX's atomic classes: the
   * class for a given (property, value, condition) is a deterministic hash, so
   * declaring the SAME rule locally yields the same class names, and asking
   * whether the button carries them is a real check on the rule it compiled
   * with — not on a string in the source.
   *
   * This fails at the WHA-116 tip, where the button declared no outline at all
   * and fell through to the browser's default ring.
   */
  it("declares the shell's 2px accent focus ring on the select button", () => {
    const expected = stylex.create({
      ring: {
        outline: {
          default: null,
          ":focus-visible": "2px solid var(--conan-color-accent)",
        },
        outlineOffset: { default: "0", ":focus-visible": "-2px" },
      },
    });
    // Dev builds prepend a readable debug name ("ThreadRow__expected.ring")
    // that is unique per declaration site; only the atomic hashes are shared.
    const wanted = (stylex.props(expected.ring).className ?? "")
      .split(" ")
      .filter((name) => name && !name.includes("__"));
    expect(wanted.length).toBeGreaterThan(0);

    render(<ThreadRow title="Analyze" subtitle="..." />);
    const button = screen.getByRole("button", { name: "Analyze: ..." });

    expect(button.className.split(" ")).toEqual(expect.arrayContaining(wanted));
  });

  /**
   * The three states ride three separate channels (WHA-116's rule): hover owns
   * the wash, selection owns the accent bar, focus owns the outline. Selecting
   * a row must therefore not touch the button's classes — if a future change
   * routes selection back through the button, this catches it.
   */
  it("keeps selection off the focusable button's own styling", () => {
    const { rerender } = render(<ThreadRow title="Analyze" subtitle="..." />);
    const before = screen.getByRole("button", { name: "Analyze: ..." }).className;

    rerender(<ThreadRow title="Analyze" subtitle="..." isSelected />);
    const after = screen.getByRole("button", { name: "Analyze: ..." }).className;

    expect(after).toBe(before);
    expect(screen.getByRole("button", { name: "Analyze: ..." })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
