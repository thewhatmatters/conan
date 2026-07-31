import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { pillOf, useV2ThreadState } from "../lib/useV2ThreadState.ts";

describe("useV2ThreadState", () => {
  it("keeps each thread's live report separate", () => {
    const { result } = renderHook(() => useV2ThreadState());
    act(() => {
      result.current.reportState("one", {
        status: "open",
        busy: true,
        awaitingApproval: false,
      });
    });
    expect(pillOf(result.current.states.one)).toBe("working");
    expect(pillOf(result.current.states.two)).toBe("idle");
  });

  it("prioritizes approval over busy, then ready over idle", () => {
    expect(
      pillOf({ status: "open", busy: true, awaitingApproval: true }),
    ).toBe("awaiting");
    expect(
      pillOf({ status: "open", busy: false, awaitingApproval: false }),
    ).toBe("ready");
    expect(
      pillOf({ status: "closed", busy: false, awaitingApproval: false }),
    ).toBe("idle");
  });
});
