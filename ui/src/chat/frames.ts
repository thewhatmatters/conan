/**
 * `/ws/agent` frame → `ChatAction`.
 *
 * The wire contract lived inside `useAgentChat`'s `onmessage`, which was fine
 * while exactly one adapter owned a socket. `sessionStore.ts` (WHA-105) is a
 * second one, and a frame the two translated differently would be a silent
 * divergence between v1 and v2 transcripts — so the translation is one pure
 * function both call.
 *
 * Pure by the same rule the reducer follows: `now` is passed in, never read.
 * An unparseable or unknown frame returns null and is dropped, matching the
 * previous behaviour exactly.
 */
import type { AgentCapabilities, AgentEvent } from "../../../src/agent/driver.ts";
import type { ChatAction } from "./reducer.ts";

export function frameToAction(raw: string, now: number): ChatAction | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (msg.type === "busy") return { type: "busy", busy: msg.busy === true };
  if (msg.type === "capabilities") {
    // Sent when the driver is built — what THIS session's provider can
    // actually do (US-007/US-009). The permission chip and approval UI adapt
    // to it without ever branching on a provider name.
    return {
      type: "capabilities",
      capabilities: (msg.capabilities as AgentCapabilities) ?? null,
    };
  }
  if (msg.type === "error") {
    return { type: "server-error", message: String(msg.message ?? "error") };
  }
  if (msg.type === "event") {
    return { type: "server-event", event: msg.event as AgentEvent, now };
  }
  return null;
}
