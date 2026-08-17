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
import { SURFACE_OPTIONS, type SurfaceId } from "../components/SurfaceTabs.tsx";

export const V2_VIEW_STATE_KEY = "conan-v2-view";

/** Surfaces that can be restored after an app restart. Terminal is excluded:
 *  its pty dies when the app quits, so restoring it would only show a dead shell. */
export type RestorableSurfaceId = Exclude<SurfaceId, "chat" | "terminal">;

/** Per-thread surface tab state as it is written to localStorage. */
export interface PersistedThreadSurfaces {
  open: RestorableSurfaceId[];
  active: SurfaceId;
  /** The Browser surface's URL, if browser is open and has loaded a page. */
  browserUrl?: string | null;
}

export interface V2ViewState {
  projectOrder: ProjectOrder;
  threadOrder: ThreadOrder;
  /** Surface tabs keyed by thread identity (WHA-205). Only open surfaces and the
   *  active tab are stored; Terminal is never stored. */
  surfaceTabs: Record<string, PersistedThreadSurfaces>;
}

export const DEFAULT_VIEW_STATE: V2ViewState = {
  projectOrder: DEFAULT_PROJECT_ORDER,
  threadOrder: DEFAULT_THREAD_ORDER,
  surfaceTabs: {},
};

const RESTORABLE_SURFACE_IDS: RestorableSurfaceId[] = SURFACE_OPTIONS.map(
  (surface) => surface.id,
).filter((id): id is RestorableSurfaceId => id !== "terminal");

function isRestorableSurfaceId(id: unknown): id is RestorableSurfaceId {
  return typeof id === "string" && RESTORABLE_SURFACE_IDS.includes(id as RestorableSurfaceId);
}

function isSurfaceId(id: unknown): id is SurfaceId {
  return (
    typeof id === "string" &&
    (id === "chat" || SURFACE_OPTIONS.some((surface) => surface.id === id))
  );
}

function validatePersistedThreadSurfaces(
  raw: unknown,
): PersistedThreadSurfaces | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { open, active, browserUrl } = raw as Partial<PersistedThreadSurfaces>;

  const validOpen = Array.isArray(open)
    ? open.filter(isRestorableSurfaceId)
    : [];
  const validActive = isSurfaceId(active) ? active : "chat";
  // A corrupt stored value must boot to chat-only rather than throw.
  if (validActive !== "chat" && !validOpen.some((id) => id === validActive)) {
    return { open: validOpen, active: "chat" };
  }
  return {
    open: validOpen,
    active: validActive,
    browserUrl: typeof browserUrl === "string" || browserUrl === null
      ? browserUrl
      : undefined,
  };
}

/** Read + validate the stored pair. Exported for the tests that pin the
 *  corrupt-value behaviour, which is the half most likely to rot. */
export function readViewState(): V2ViewState {
  try {
    const raw = localStorage.getItem(V2_VIEW_STATE_KEY);
    if (raw === null) return DEFAULT_VIEW_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_VIEW_STATE;
    const { projectOrder, threadOrder, surfaceTabs } = parsed as Partial<V2ViewState>;

    let validSurfaceTabs: Record<string, PersistedThreadSurfaces> = {};
    if (typeof surfaceTabs === "object" && surfaceTabs !== null) {
      for (const [key, value] of Object.entries(surfaceTabs)) {
        const validated = validatePersistedThreadSurfaces(value);
        if (validated && validated.open.length > 0) {
          validSurfaceTabs[key] = validated;
        }
      }
    }

    return {
      projectOrder: isProjectOrder(projectOrder)
        ? projectOrder
        : DEFAULT_PROJECT_ORDER,
      threadOrder: isThreadOrder(threadOrder)
        ? threadOrder
        : DEFAULT_THREAD_ORDER,
      surfaceTabs: validSurfaceTabs,
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
  setSurfaceTabs: (tabs: Record<string, PersistedThreadSurfaces>) => void;
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
  const setSurfaceTabs = useCallback(
    (surfaceTabs: Record<string, PersistedThreadSurfaces>) =>
      update({ surfaceTabs }),
    [update],
  );

  return { ...state, setProjectOrder, setThreadOrder, setSurfaceTabs };
}
