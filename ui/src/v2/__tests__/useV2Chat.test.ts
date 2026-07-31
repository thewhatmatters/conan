/**
 * useV2Chat — adapter over v1's useAgentChat (US-201).
 *
 * Proves the seam exposes the p2a surface and does not open a socket when the
 * token is null (same gate as useAgentChat).
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useV2Chat } from "../lib/useV2Chat.ts";

describe("useV2Chat", () => {
  it("exposes items, send, status, busy, approval state (and interrupt for stop)", () => {
    const { result } = renderHook(() => useV2Chat(null));

    expect(result.current.items).toEqual([]);
    expect(typeof result.current.send).toBe("function");
    expect(typeof result.current.interrupt).toBe("function");
    expect(result.current.busy).toBe(false);
    expect(result.current.awaitingApproval).toBe(false);
    expect(result.current.pendingApproval).toBeNull();
    expect(result.current.pendingApprovals).toEqual([]);
    expect(typeof result.current.respondToApproval).toBe("function");
    // No token → no socket → stays connecting (useAgentChat never opens).
    expect(result.current.status).toBe("connecting");
  });
});
