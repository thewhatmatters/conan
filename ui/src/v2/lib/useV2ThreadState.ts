import { useCallback, useState } from "react";
import type { ChatStatus } from "./useV2Chat.ts";

export type V2ThreadPill = "working" | "awaiting" | "ready" | "idle";

export interface V2ThreadUiState {
  status: ChatStatus;
  busy: boolean;
  awaitingApproval: boolean;
}

export function pillOf(state: V2ThreadUiState | undefined): V2ThreadPill {
  if (!state) return "idle";
  if (state.awaitingApproval) return "awaiting";
  if (state.busy) return "working";
  if (state.status === "open") return "ready";
  return "idle";
}

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
