/**
 * A self-healing WebSocket wrapper (US-018). It owns the connection lifecycle so
 * the dashboard recovers from dropped sockets without a page reload:
 *  - optional app-level heartbeat ping; a missed pong over a full interval marks
 *    the connection dead and forces a reconnect (browsers don't surface a
 *    silently-dropped TCP otherwise),
 *  - exponential backoff between reconnect attempts (with jitter),
 *  - a status callback (connecting / connected / reconnecting / offline) for a
 *    UI indicator,
 *  - an onOpen hook so callers can re-subscribe / replay after each (re)connect.
 *
 * It is transport-only: callers parse frames in onMessage and send via send().
 */
export type ConnStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface ResilientSocketOptions {
  /** Computed fresh on each (re)connect — token/params may have changed. */
  url: () => string;
  /** Raw inbound frame handler. */
  onMessage?: (ev: MessageEvent) => void;
  /** Status transitions, for a connection indicator. */
  onStatus?: (status: ConnStatus) => void;
  /** Runs after each successful open (send subscribe frames, request replay…). */
  onOpen?: (socket: WebSocket) => void;
  /** Build a heartbeat ping frame. Omit to disable app-level heartbeating. */
  ping?: () => string;
  /** Heartbeat interval (ms). A tick with no inbound traffic since the previous
   *  ping marks the socket dead. Ignored unless `ping` is set. */
  heartbeatMs?: number;
  /** Backoff bounds for reconnect delay (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect attempts before status flips to "offline" (it keeps retrying). */
  offlineAfter?: number;
}

export class ResilientSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private awaitingPong = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ResilientSocketOptions) {
    this.connect();
  }

  /** Send a frame if the socket is open; a no-op while down (caller re-syncs on
   *  reconnect via onOpen). */
  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  /** Permanently close: stop heartbeating and reconnecting, drop the socket. */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
  }

  private setStatus(s: ConnStatus): void {
    this.opts.onStatus?.(s);
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.awaitingPong = false;
      this.setStatus("connected");
      this.opts.onOpen?.(ws);
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      this.awaitingPong = false; // any inbound traffic proves liveness
      this.opts.onMessage?.(ev);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* triggers onclose below */
      }
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      if (!this.closed) this.scheduleReconnect();
    };
  }

  private startHeartbeat(): void {
    if (!this.opts.ping || !this.opts.heartbeatMs) return;
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        // Previous ping went unanswered for a full interval — declare it dead
        // and force a reconnect rather than waiting on the OS TCP timeout.
        try {
          ws.close();
        } catch {
          /* onclose handles the rest */
        }
        return;
      }
      this.awaitingPong = true;
      try {
        ws.send(this.opts.ping!());
      } catch {
        /* will be caught by the next tick / onclose */
      }
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.ws = null;
    this.attempts += 1;
    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 15_000;
    const base = Math.min(max, min * 2 ** (this.attempts - 1));
    const delay = base + Math.random() * base * 0.2; // jitter to avoid thundering herd
    this.setStatus(this.attempts >= (this.opts.offlineAfter ?? 4) ? "offline" : "reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
