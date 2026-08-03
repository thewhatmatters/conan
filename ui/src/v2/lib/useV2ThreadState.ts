import { useCallback, useState } from "react";
import { pillOf, type Pill, type ThreadPillState } from "../../chat/model.ts";

// The pill derivation lives in the shared chat model (ui/src/chat/model.ts) —
// the V2 names stay as aliases/re-exports for this tree's existing importers.
export type V2ThreadPill = Pill;
export type V2ThreadUiState = ThreadPillState;
export { pillOf };

export function useV2ThreadState() {
  const [states, setStates] = useState<Record<string, V2ThreadUiState>>({});

  const reportState = useCallback((key: string, next: V2ThreadUiState) => {
    setStates((current) => {
      const previous = current[key];
      if (
        previous?.status === next.status &&
        previous.busy === next.busy &&
        previous.awaitingApproval === next.awaitingApproval
      ) {
        return current;
      }
      return { ...current, [key]: next };
    });
  }, []);

  return { states, reportState };
}
