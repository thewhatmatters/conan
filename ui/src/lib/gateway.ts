/**
 * Gateway-base resolver (US-006).
 *
 * The UI talks to the Node gateway over the same loopback host whether it is
 * served as a web page or embedded in the Tauri desktop webview — but the two
 * contexts differ in *origin*:
 *  - **Browser dev / web-served:** the page origin is same-origin with the
 *    gateway (`:3747`) or proxied by Vite (`:5173`). Relative URLs (`/api/…`,
 *    same-host `ws://`) just work, so the base is `""`.
 *  - **Tauri:** the webview origin is `tauri://localhost`, which is NOT the
 *    gateway origin, so relative URLs would resolve against `tauri://` and fail.
 *    We point fetch + WebSocket at the gateway's absolute loopback URL instead.
 *
 * Tauri is detected via `__TAURI_INTERNALS__` on `window` (present only inside
 * the Tauri webview). The gateway port is pinned to 3747 by the sidecar env
 * (US-009), so the hard-coded base is safe.
 */

const TAURI_GATEWAY_HOST = "127.0.0.1:3747";

/** True when running inside the Tauri webview (not a plain browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Origin prefix for HTTP(S) requests to the gateway. `""` (same-origin) in the
 * browser so the Vite proxy / same-origin host applies; the absolute loopback
 * URL under Tauri. Concatenate with a leading-slash path: `apiBase() + "/api/x"`.
 */
export function apiBase(): string {
  return isTauri() ? `http://${TAURI_GATEWAY_HOST}` : "";
}

/**
 * Build an absolute WebSocket URL for a gateway path (e.g. `/ws`,
 * `/ws/terminal`). Under Tauri this targets the loopback gateway over `ws://`;
 * in the browser it follows the page's host + protocol (`wss://` under HTTPS,
 * preserving the existing TLS/remote-access behavior). The `path` must start
 * with a slash; pass any query string as part of `path`.
 */
export function wsUrl(path: string): string {
  if (isTauri()) return `ws://${TAURI_GATEWAY_HOST}${path}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
