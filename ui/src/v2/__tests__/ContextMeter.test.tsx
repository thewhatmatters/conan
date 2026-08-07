/**
 * ContextProgress — WHA-101 honesty rules in WHA-119's Full Featured bar.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ContextProgress from "../chat/composer/ContextProgress.tsx";
import {
  contextMeterState,
  contextPressureStatus,
  detectContextCompaction,
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

describe("contextPressureStatus", () => {
  it("stays quiet for normal and unknown-window usage", () => {
    expect(contextPressureStatus(contextMeterState(45_000, 200_000))).toBeUndefined();
    expect(contextPressureStatus(contextMeterState(45_000, null))).toBeUndefined();
  });

  it("gives recovery copy at warning and error thresholds", () => {
    expect(contextPressureStatus(contextMeterState(150_000, 200_000), true)).toEqual({
      type: "warning",
      message: expect.stringMatching(/75%.*compact when needed/i),
    });
    expect(contextPressureStatus(contextMeterState(180_000, 200_000), true)).toEqual({
      type: "error",
      message: expect.stringMatching(/90%.*compact when needed.*new thread/i),
    });
    expect(contextPressureStatus(contextMeterState(180_000, 200_000))).toEqual({
      type: "error",
      message: expect.not.stringMatching(/will compact/i),
    });
  });
});

describe("detectContextCompaction", () => {
  it("confirms a large measured reset from pressure territory", () => {
    expect(detectContextCompaction(192_000, 76_000, 200_000)).toEqual({
      fromPct: 96,
      toPct: 38,
      message: "Context compacted · 96% → 38%",
    });
  });

  it("does not mislabel ordinary movement, unknown windows, or low usage", () => {
    expect(detectContextCompaction(160_000, 140_000, 200_000)).toBeNull();
    expect(detectContextCompaction(120_000, 40_000, 200_000)).toBeNull();
    expect(detectContextCompaction(190_000, 60_000, null)).toBeNull();
  });
});

describe("ContextProgress", () => {
  it("renders nothing when used is null", () => {
    const { container } = render(
      <ContextProgress used={null} windowTokens={200_000} />,
    );
    expect(container.querySelector('[data-slot="context-progress"]')).toBeNull();
  });

  it("renders Astryx progress with percentage metadata when both values are known", () => {
    const { container } = render(
      <ContextProgress used={45_000} windowTokens={200_000} />,
    );
    const progress = screen.getByRole("progressbar", { name: "Context" });
    expect(progress).toHaveAttribute("aria-valuenow", "22.5");
    expect(container.querySelector('[data-slot="context-progress"]')).toHaveAttribute(
      "data-pct",
      "23",
    );
    expect(screen.queryByText("23% · 45k/200k")).toBeNull();
  });

  it("shows only an honest raw count when the window is unknown", () => {
    const { container } = render(
      <ContextProgress used={12_000} windowTokens={null} />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("12k tokens")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="context-progress"]')).toHaveAttribute(
      "data-pct",
      "unknown",
    );
  });
});
