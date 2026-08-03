/**
 * useV2Chat — adapter over v1's useAgentChat (US-201).
 *
 * Proves the seam exposes the p2a surface (plus WHA-97 permission/capabilities
 * pass-throughs) and does not open a socket when the token is null.
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

  // WHA-97: restore the six pass-throughs the skeleton omitted. Without these
  // the v2 composer cannot follow live permission mode, and WHA-101 has no
  // contextTokens/capabilities to meter.
  it("passes through permission, session, capabilities, and error surfaces", () => {
    const { result } = renderHook(() => useV2Chat(null));

    expect(result.current.contextTokens).toBeNull();
    expect(result.current.sessionId).toBeNull();
    expect(result.current.permissionMode).toBeNull();
    expect(result.current.capabilities).toBeNull();
    expect(typeof result.current.setPermissionMode).toBe("function");
    expect(typeof result.current.reportError).toBe("function");
  });
});
