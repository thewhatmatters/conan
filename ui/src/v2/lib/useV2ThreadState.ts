import { useSyncExternalStore } from "react";
import { pillOf, type Pill, type ThreadPillState } from "../../chat/model.ts";
import { getLiveThreadStates, subscribeToSessions } from "../../chat/sessionStore.ts";

// The pill derivation lives in the shared chat model (ui/src/chat/model.ts) —
// the V2 names stay as aliases/re-exports for this tree's existing importers.
export type V2ThreadPill = Pill;
export type V2ThreadUiState = ThreadPillState;
export { pillOf };

/**
 * Live pill state for every thread with an open session, keyed by thread.
 *
 * WHA-105: this used to be a `reportState` callback the MOUNTED chat view
 * pushed into, which could only ever describe the thread you were looking at —
 * and, worse, reported `closed` on unmount, so leaving a thread said its
 * session had ended. Sessions now outlive their view, so the registry is the
 * honest source: a thread still working in the background reads `working` in
 * the rail instead of going quiet.
 *
 * A thread with no live session is simply absent, and `pillOf(undefined)` is
 * `idle` — the same thing a never-opened thread shows.
 */
export function useV2ThreadStates(): Record<string, V2ThreadUiState> {
  return useSyncExternalStore(subscribeToSessions, getLiveThreadStates);
}
