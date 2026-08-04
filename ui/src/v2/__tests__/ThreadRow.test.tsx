/**
 * ThreadRow trailing slot + row menu — WHA-87, reworked by WHA-103 (2026-08-04).
 *
 * The trailing lane used to swap a timestamp for a hover kebab. The kebab is
 * gone: thread actions are RIGHT-CLICK ON THE ROW (Randy's call), so the
 * timestamp simply stays put and the row itself is the menu trigger.
 *
 * What these tests can honestly assert is the markup contract and the pure
 * logic — what "2d ago" resolves to, that the label carries the absolute
 * datetime, and that the gesture reaches the menu. Paint and layout are not
 * asserted here: jsdom neither lays out nor paints, so those belong to the
 * browser pass.
 */
import { describe, expect, it, vi } from "vitest";
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

  it("leaves the timestamp alone in the trailing slot — no kebab beside it", () => {
    const { container } = render(
      <ThreadRow
        title="Analyze"
        subtitle="..."
        lastActivity={NOW - DAY}
        onNewThread={() => {}}
      />,
    );

    const slot = container.querySelector('[data-slot="thread-trailing"]');
    const stamp = container.querySelector('[data-slot="thread-timestamp"]');
    expect(slot?.contains(stamp!)).toBe(true);
    expect(container.querySelector('[data-slot="thread-actions"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for Analyze" })).not.toBeInTheDocument();
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
  });
});
