/**
 * V2ThinkingOrb — WHA-90.
 *
 * What jsdom can settle honestly: the escalation tiers, the copy at each one,
 * and that the orb occupies the assistant slot the streaming handoff already
 * uses. What it CANNOT settle is the animation — `thinking-orbs` paints to a
 * 2D canvas, and jsdom has no canvas renderer, so anything this file claimed
 * about motion would be fiction. The reduced-motion behaviour and the look are
 * checked in the browser pass instead.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import V2ThinkingOrb, { ESCALATION_MS, tierFor } from "../chat/V2ThinkingOrb.tsx";

afterEach(() => {
  vi.useRealTimers();
});

describe("tierFor", () => {
  it("stays silent through the first seconds — most turns finish there", () => {
    expect(tierFor(0)).toBe("silent");
    expect(tierFor(ESCALATION_MS.label - 1)).toBe("silent");
  });

  it("labels, then escalates once at 30s and again at 3min", () => {
    expect(tierFor(ESCALATION_MS.label)).toBe("label");
    expect(tierFor(ESCALATION_MS.still - 1)).toBe("label");
    expect(tierFor(ESCALATION_MS.still)).toBe("still");
    expect(tierFor(ESCALATION_MS.long - 1)).toBe("still");
    expect(tierFor(ESCALATION_MS.long)).toBe("long");
    expect(tierFor(ESCALATION_MS.long * 10)).toBe("long");
  });
});

describe("V2ThinkingOrb", () => {
  it("shows the mark with no copy at first", () => {
    const { container } = render(<V2ThinkingOrb elapsedMsForTest={0} />);

    const root = container.querySelector('[data-slot="v2-thinking-orb"]');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute("data-tier", "silent");
    expect(root?.textContent).toBe("");
  });

  it("carries the right copy at each escalation tier", () => {
    for (const [ms, copy] of [
      [ESCALATION_MS.label, "Working…"],
      [ESCALATION_MS.still, "Still working…"],
      [ESCALATION_MS.long, "Still working — this one is taking a while"],
    ] as const) {
      const { unmount } = render(<V2ThinkingOrb elapsedMsForTest={ms} />);
      expect(screen.getByText(copy)).toBeInTheDocument();
      unmount();
    }
  });

  // The package defaults aria-label to its STATE name ("Solving…"), which is
  // not the word we render. These two pin the screen and the a11y tree
  // together so the next copy change cannot desync them unnoticed.
  it("names the silent mark with the copy it stands in for", () => {
    render(<V2ThinkingOrb elapsedMsForTest={0} />);

    expect(screen.getByRole("img")).toHaveAccessibleName("Working…");
    expect(screen.queryByRole("img", { name: "Solving…" })).toBeNull();
  });

  it("drops the mark from the a11y tree once the copy says it out loud", () => {
    render(<V2ThinkingOrb elapsedMsForTest={ESCALATION_MS.still} />);

    // One announcement of the state, not two.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Still working…")).toBeInTheDocument();
  });

  it("escalates on real timers without a per-second re-render", () => {
    vi.useFakeTimers();
    const { container } = render(<V2ThinkingOrb />);
    const tier = () =>
      container.querySelector('[data-slot="v2-thinking-orb"]')?.getAttribute("data-tier");

    expect(tier()).toBe("silent");
    act(() => void vi.advanceTimersByTime(ESCALATION_MS.label));
    expect(tier()).toBe("label");
    act(() => void vi.advanceTimersByTime(ESCALATION_MS.still - ESCALATION_MS.label));
    expect(tier()).toBe("still");
    act(() => void vi.advanceTimersByTime(ESCALATION_MS.long - ESCALATION_MS.still));
    expect(tier()).toBe("long");
  });

  it("clears its timers on unmount — a resolved turn must not keep ticking", () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<V2ThinkingOrb />);
    unmount();
    expect(clear).toHaveBeenCalledTimes(3);
    clear.mockRestore();
  });
});
