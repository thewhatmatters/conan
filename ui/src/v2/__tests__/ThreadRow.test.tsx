/**
 * ThreadRow trailing slot — WHA-87 (design: WHA-75, Paper 1IU-0).
 *
 * The row's trailing lane holds ONE slot with TWO occupants: a relative
 * timestamp at rest, the kebab on hover/focus. The swap is CSS, so what these
 * tests can honestly assert is the contract the CSS hangs off — both occupants
 * present in the same slot, correctly marked up — plus the part that is pure
 * logic: what "2d ago" resolves to, and that the label stays honest by carrying
 * the absolute datetime.
 *
 * The visual swap itself (no layout shift, opacity crossfade) is NOT asserted
 * here: jsdom neither lays out nor paints, so a passing assertion about it
 * would be a lie. That one is checked in the browser pass.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("puts the kebab in the same slot as the timestamp", () => {
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
});
