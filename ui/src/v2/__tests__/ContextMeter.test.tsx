/**
 * ContextMeter — pure model honesty rules + presence of the ring (WHA-101).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ContextMeter from "../chat/composer/ContextMeter.tsx";
import {
  contextMeterState,
  fmtTokens,
} from "../chat/composer/contextMeterModel.ts";

describe("fmtTokens", () => {
  it.each([
    [999, "999"],
    [10_000, "10k"],
    [45_000, "45k"],
    [200_000, "200k"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
  ] as const)("fmtTokens(%i) → %s", (n, label) => {
    expect(fmtTokens(n)).toBe(label);
  });
});

describe("contextMeterState", () => {
  it("is absent when no usage has been reported", () => {
    expect(contextMeterState(null, 200_000)).toBeNull();
    expect(contextMeterState(undefined, 200_000)).toBeNull();
  });

  it("shows raw count with no percentage when the window is unknown", () => {
    const s = contextMeterState(45_000, null);
    expect(s).not.toBeNull();
    expect(s!.pct).toBeNull();
    expect(s!.variant).toBe("neutral");
    expect(s!.summary).toBe("45k tokens");
    expect(s!.detail).toMatch(/no context-window size/i);
  });

  it("computes percentage and default variant under 75%", () => {
    const s = contextMeterState(45_000, 200_000);
    expect(s!.pct).toBeCloseTo(22.5);
    expect(s!.variant).toBe("default");
    expect(s!.summary).toBe("23% · 45k/200k");
  });

  it("warns at ≥75% and errors at ≥90%", () => {
    expect(contextMeterState(150_000, 200_000)!.variant).toBe("warning");
    expect(contextMeterState(180_000, 200_000)!.variant).toBe("error");
    expect(contextMeterState(200_000, 200_000)!.pct).toBe(100);
  });

  it("treats a zero window as unknown (never divides by zero)", () => {
    const s = contextMeterState(1_000, 0);
    expect(s!.pct).toBeNull();
    expect(s!.variant).toBe("neutral");
  });
});

describe("ContextMeter", () => {
  it("renders nothing when used is null", () => {
    const { container } = render(
      <ContextMeter used={null} windowTokens={200_000} />,
    );
    expect(container.querySelector('[data-slot="context-meter"]')).toBeNull();
  });

  it("renders the ring with percentage metadata when both values are known", () => {
    render(<ContextMeter used={45_000} windowTokens={200_000} />);
    const ring = screen.getByRole("img", { name: /Context window/ });
    expect(ring).toHaveAttribute("data-slot", "context-meter");
    expect(ring).toHaveAttribute("data-variant", "default");
    expect(ring).toHaveAttribute("data-pct", "23");
  });

  it("marks unknown-window as neutral", () => {
    render(<ContextMeter used={12_000} windowTokens={null} />);
    const ring = screen.getByRole("img", { name: /12k tokens/ });
    expect(ring).toHaveAttribute("data-variant", "neutral");
    expect(ring).toHaveAttribute("data-pct", "unknown");
  });
});
