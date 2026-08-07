/**
 * Live agent-session registry (WHA-105).
 *
 * ONE `/ws/agent` socket per THREAD, owned outside React and outlasting the
 * component that renders it.
 *
 * The bug this exists to fix: v2 keys `V2ChatView` on the sidebar selection,
 * so switching threads unmounts it. `useAgentChat` owns its socket in an
 * effect, so the unmount closed it — and the gateway disposes the driver on
 * socket close (`src/agent/index.ts`), which SIGTERMs the `claude` child
 * (`src/agent/claude.ts`). Switching away from a working thread killed the
 * turn and lost every token it had produced. v1 avoided this by keeping every
 * `ChatPane` mounted-but-hidden; v2 has no hidden panes and should not grow
 * N transcripts in the DOM to get one live socket each.
 *
 * So the session — socket plus the reducer state it folds into — lives here,
 * keyed by the shell's thread key, and a mounting view merely SUBSCRIBES.
 * Unmounting drops the listener and nothing else: the socket stays open, the
 * turn keeps streaming, and coming back re-attaches to the same state object.
 *
 * The reducer is already pure (`reducer.ts`), so driving it outside React is
 * just calling it — no state lives in this module that the reducer doesn't own.
 *
 * A session ends only when something real ends it: the thread is deleted, the
 * token rotates, or the idle-eviction below reclaims it.
 */
import { wsUrl } from "../lib/gateway.ts";
import { frameToAction } from "./frames.ts";
import type { ThreadPillState } from "./model.ts";
import {
  initialChatState,
  reduceChat,
  type ChatAction,
  type ChatSessionState,
} from "./reducer.ts";

/**
 * How many live sessions the registry keeps.
 *
 * Each one holds an agent process open on the gateway, so "never close
 * anything" would leak a `claude` per thread the user ever glanced at. Past
 * the cap the LEAST RECENTLY ACQUIRED session is closed — but only if it is
 * genuinely idle: never one a view is subscribed to, never one mid-turn, and
 * never one holding an unanswered approval. Closing an idle session is
 * invisible, because reopening that thread reconstructs its transcript from
 * the provider's own JSONL and resumes it (`useV2ThreadHistory`) exactly as a
 * cold open does today. If nothing is evictable the cap is exceeded rather
 * than a running turn killed — which is the whole point of the ticket.
 */
const MAX_LIVE_SESSIONS = 6;

interface LiveSession {
  key: string;
  token: string;
  socket: WebSocket;
  state: ChatSessionState;
  listeners: Set<() => void>;
  handle: AgentSessionHandle;
}

/** What a subscribing view gets. Stable per session, so `useSyncExternalStore`
 *  sees the same `subscribe` identity for the life of the session. */
export interface AgentSessionHandle {
  getState: () => ChatSessionState;
  subscribe: (listener: () => void) => () => void;
  /** Fold a LOCAL intent (`user-sent`, `approval-responded`, `client-error`)
   *  into the session. Server frames arrive through the socket. */
  dispatch: (action: ChatAction) => void;
  /** Send an outgoing frame. False when the socket is not open — callers use
   *  it to skip the optimistic transcript entry, as `useAgentChat` does. */
  send: (frame: Record<string, unknown>) => boolean;
}

// Insertion order IS the LRU order: `acquire` re-inserts on every hit.
const sessions = new Map<string, LiveSession>();
const registryListeners = new Set<() => void>();

/** Cached `getLiveThreadStates()` result, invalidated on any change so the
 *  snapshot stays referentially stable between renders. */
let statesSnapshot: Record<string, ThreadPillState> | null = null;

function notifyRegistry(): void {
  statesSnapshot = null;
  for (const listener of registryListeners) listener();
}

function pillOfState(state: ChatSessionState): ThreadPillState {
  return {
    status: state.status,
    busy: state.busy,
    awaitingApproval: state.pendingApprovals.length > 0,
  };
}

function apply(session: LiveSession, action: ChatAction): void {
  const next = reduceChat(session.state, action);
  if (next === session.state) return;
  const before = pillOfState(session.state);
  session.state = next;
  for (const listener of session.listeners) listener();
  // Only when the SIDEBAR-visible slice moved. Every streamed token is a
  // state change; waking the whole shell for each one would make the rail the
  // most expensive thing on screen.
  const after = pillOfState(next);
  if (
    before.status !== after.status ||
    before.busy !== after.busy ||
    before.awaitingApproval !== after.awaitingApproval
  ) {
    notifyRegistry();
  }
}

function open(key: string, token: string): LiveSession {
  const socket = new WebSocket(wsUrl(`/ws/agent?token=${token}`));
  const session: LiveSession = {
    key,
    token,
    socket,
    state: initialChatState,
    listeners: new Set(),
    handle: undefined as unknown as AgentSessionHandle,
  };
  session.handle = {
    getState: () => session.state,
    subscribe: (listener) => {
      session.listeners.add(listener);
      return () => {
        // Deliberately does NOT close the socket. This runs on every thread
        // switch, and closing here is the bug.
        session.listeners.delete(listener);
      };
    },
    dispatch: (action) => apply(session, action),
    send: (frame) => {
      if (session.socket.readyState !== WebSocket.OPEN) return false;
      session.socket.send(JSON.stringify(frame));
      return true;
    },
  };
  socket.onopen = () => apply(session, { type: "connection-open" });
  socket.onclose = () => {
    // A REMOTE close (gateway restart, network drop) ends the session for
    // good. Local closes (`closeSession`) null this handler first, so the
    // reducer's connection-lost notice never fires for them.
    apply(session, { type: "connection-lost" });
  };
  socket.onerror = () => apply(session, { type: "connection-error" });
  socket.onmessage = (event) => {
    const action = frameToAction(event.data as string, Date.now());
    if (action) apply(session, action);
  };
  return session;
}

/** Idle enough to reclaim: nothing rendering it, no turn in flight, nothing
 *  waiting on the user. */
function evictable(session: LiveSession): boolean {
  return (
    session.listeners.size === 0 &&
    !session.state.busy &&
    session.state.pendingApprovals.length === 0
  );
}

function evictBeyondCap(): void {
  if (sessions.size <= MAX_LIVE_SESSIONS) return;
  for (const session of sessions.values()) {
    if (sessions.size <= MAX_LIVE_SESSIONS) return;
    if (evictable(session)) closeSession(session.key);
  }
}

/**
 * The live session for a thread, opening one if there is none.
 *
 * Idempotent — StrictMode's double subscribe/unsubscribe hits the same
 * session. A token change closes the old socket and opens a new one, because
 * the gateway authenticates on upgrade and the old socket cannot be re-authed.
 */
export function acquireSession(key: string, token: string): AgentSessionHandle {
  const existing = sessions.get(key);
  if (existing && existing.token === token) {
    sessions.delete(key);
    sessions.set(key, existing);
    return existing.handle;
  }
  if (existing) closeSession(key);
  const session = open(key, token);
  sessions.set(key, session);
  evictBeyondCap();
  notifyRegistry();
  return session.handle;
}

/** Subscribe a view to a thread's session, opening it on first subscribe.
 *  Called from React's commit phase (the `useSyncExternalStore` contract), so
 *  the socket is never opened during render. */
export function subscribeToSession(
  key: string,
  token: string,
  listener: () => void,
): () => void {
  return acquireSession(key, token).subscribe(listener);
}

/** A thread's session state, or the initial (never-connected) one. Stable by
 *  identity while nothing changes — `useSyncExternalStore` requires it. */
export function getSessionState(key: string): ChatSessionState {
  return sessions.get(key)?.state ?? initialChatState;
}

/** Outgoing frame for a thread. False when there is no open socket. */
export function sendToSession(key: string, frame: Record<string, unknown>): boolean {
  return sessions.get(key)?.handle.send(frame) ?? false;
}

/** Fold a local intent into a thread's session. No-op with no live session. */
export function dispatchToSession(key: string, action: ChatAction): void {
  sessions.get(key)?.handle.dispatch(action);
}

/**
 * End a thread's session for real — the socket closes, the gateway disposes
 * the driver, and the agent process exits. For a thread that no longer exists
 * (deleted, or its project removed), not for a thread the user navigated away
 * from.
 */
export function closeSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  // Null the handlers before closing: this is a LOCAL teardown, not a lost
  // connection, and the transcript notice must not fire for it.
  session.socket.onmessage = null;
  session.socket.onclose = null;
  session.socket.onerror = null;
  session.socket.close();
  notifyRegistry();
}

/** End every session — the gateway token rotated, or a test is resetting. */
export function closeAllSessions(): void {
  for (const key of [...sessions.keys()]) closeSession(key);
}

/** Subscribe to the SET of live sessions and their pill-relevant state. */
export function subscribeToSessions(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/**
 * Pill state for every live session, keyed by thread.
 *
 * The sidebar used to learn this only from the mounted view, so it could only
 * ever describe the thread you were looking at. With sessions outliving their
 * views the registry knows it for all of them, which is what makes a
 * background turn visible as `working` in the rail instead of `idle`.
 */
export function getLiveThreadStates(): Record<string, ThreadPillState> {
  if (statesSnapshot) return statesSnapshot;
  const next: Record<string, ThreadPillState> = {};
  for (const [key, session] of sessions) next[key] = pillOfState(session.state);
  statesSnapshot = next;
  return next;
}
