/**
 * Persisted v2 sidebar view state (WHA-60).
 *
 * Holds the two orderings `73D-0` exposes and survives a reload. One key
 * holding one object, not a key per setting: the two orderings are read
 * together on every render and a partially-written pair (a reload landing
 * between two `setItem` calls) is a state the reducer would then have to
 * defend against.
 *
 * Every `localStorage` touch is wrapped. It throws outright in a partitioned or
 * cookie-blocked context, and the honest fallback is an in-memory setting that
 * works for this session — a sidebar that cannot sort is worse than one that
 * forgets. This mirrors `entry.tsx`'s handling of the v2 flag.
 *
 * Unknown or corrupt stored values fall back to the defaults rather than being
 * trusted: this is user-writable storage, and a hand-edited value must not be
 * able to hand a bogus order string to the comparators.
 */
import { useCallback, useState } from "react";
import {
  DEFAULT_PROJECT_ORDER,
  DEFAULT_THREAD_ORDER,
  isProjectOrder,
  isThreadOrder,
  type ProjectOrder,
  type ThreadOrder,
} from "./projectOrder.ts";

export const V2_VIEW_STATE_KEY = "conan-v2-view";

export interface V2ViewState {
  projectOrder: ProjectOrder;
  threadOrder: ThreadOrder;
}

export const DEFAULT_VIEW_STATE: V2ViewState = {
  projectOrder: DEFAULT_PROJECT_ORDER,
  threadOrder: DEFAULT_THREAD_ORDER,
};

/** Read + validate the stored pair. Exported for the tests that pin the
 *  corrupt-value behaviour, which is the half most likely to rot. */
export function readViewState(): V2ViewState {
  try {
    const raw = localStorage.getItem(V2_VIEW_STATE_KEY);
    if (raw === null) return DEFAULT_VIEW_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_VIEW_STATE;
    const { projectOrder, threadOrder } = parsed as Partial<V2ViewState>;
    return {
      projectOrder: isProjectOrder(projectOrder)
        ? projectOrder
        : DEFAULT_PROJECT_ORDER,
      threadOrder: isThreadOrder(threadOrder)
        ? threadOrder
        : DEFAULT_THREAD_ORDER,
    };
  } catch {
    // Unreadable storage or unparseable JSON — same answer either way.
    return DEFAULT_VIEW_STATE;
  }
}

function writeViewState(state: V2ViewState): void {
  try {
    localStorage.setItem(V2_VIEW_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — the setting still applies for this session */
  }
}

export interface V2ViewStateApi extends V2ViewState {
  setProjectOrder: (order: ProjectOrder) => void;
  setThreadOrder: (order: ThreadOrder) => void;
}

export function useV2ViewState(): V2ViewStateApi {
  // Lazy initializer: reading storage on every render would be wasted work,
  // and the value cannot change under us except through the setters below.
  const [state, setState] = useState<V2ViewState>(readViewState);

  const update = useCallback((patch: Partial<V2ViewState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      writeViewState(next);
      return next;
    });
  }, []);

  const setProjectOrder = useCallback(
    (projectOrder: ProjectOrder) => update({ projectOrder }),
    [update],
  );
  const setThreadOrder = useCallback(
    (threadOrder: ThreadOrder) => update({ threadOrder }),
    [update],
  );

  return { ...state, setProjectOrder, setThreadOrder };
}
