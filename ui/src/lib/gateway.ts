/**
 * Gateway-base resolver (US-006).
 *
 * The UI talks to the Node gateway over the same loopback host whether it is
 * served as a web page or embedded in the Tauri desktop webview — but the two
 * contexts differ in *origin*:
 *  - **Browser dev / web-served:** the page origin is same-origin with the
 *    gateway (`:3747`) or proxied by Vite (`:5173`). Relative URLs (`/api/…`,
 *    same-host `ws://`) just work, so the base is `""`.
 *  - **Tauri (bundled app):** the webview origin is `tauri://localhost`, which is
 *    NOT the gateway origin, so relative URLs would resolve against `tauri://`
 *    and fail. We point fetch + WebSocket at the gateway's absolute loopback URL.
 *  - **Tauri (`tauri dev`):** the webview loads the page from the Vite dev server
 *    (`http://localhost:5173`), a real *http* origin the webview enforces CORS
 *    against. The absolute loopback base would be cross-origin and the gateway
 *    sends no CORS headers, so `/api/config` is blocked → no token → the app WS
 *    can't authenticate ("reconnecting"). But Vite already proxies `/api` + `/ws`
 *    to :3747, so in dev we stay **relative** and let the proxy handle it.
 *
 * Hence the absolute base applies only when running under Tauri AND this is a
 * production build (`import.meta.env.DEV === false`) — i.e. the bundled app, not
 * `tauri dev`. Tauri is detected via `__TAURI_INTERNALS__` on `window` (present
 * only inside the Tauri webview); the gateway port is pinned to 3747 by the
 * sidecar env (US-009), so the hard-coded base is safe.
 */

const TAURI_GATEWAY_HOST = "127.0.0.1:3747";

/** True when running inside the Tauri webview (not a plain browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * True only in the *bundled* Tauri app (Tauri webview + a production build), the
 * one context that lacks the Vite proxy and must reach the gateway absolutely.
 * `tauri dev` is excluded (`import.meta.env.DEV` is true there) so it rides the
 * Vite proxy same-origin and avoids the cross-origin CORS block.
 */
function useAbsoluteBase(): boolean {
  return isTauri() && !import.meta.env.DEV;
}

/**
 * Origin prefix for HTTP(S) requests to the gateway. `""` (same-origin) in the
 * browser AND in `tauri dev` (the Vite proxy / same-origin host applies); the
 * absolute loopback URL only in the bundled Tauri app. Concatenate with a
 * leading-slash path: `apiBase() + "/api/x"`.
 */
export function apiBase(): string {
  return useAbsoluteBase() ? `http://${TAURI_GATEWAY_HOST}` : "";
}

/**
 * URL of the gateway's radio embed-host page (v4.6 WKWebView fix), for the
 * offscreen `<iframe>` in `RadioBar.tsx`.
 *
 * This is ALWAYS the absolute loopback `http://` origin — never relative and
 * never the `tauri://` scheme — because that is the whole point of the fix:
 * YouTube's IFrame embed refuses to play under a non-http(s) origin (onError
 * 153), so the player must live in a document served from `http://127.0.0.1:3747`.
 * Using the absolute base in every context (browser, `tauri dev`, bundled app)
 * keeps the embed's origin a valid http origin YouTube accepts; cross-origin
 * `postMessage` between this iframe and the parent works regardless of scheme.
 */
export function radioEmbedUrl(videoId: string): string {
  return `http://${TAURI_GATEWAY_HOST}/radio/embed?v=${encodeURIComponent(videoId)}`;
}

/**
 * Build a WebSocket URL for a gateway path (e.g. `/ws`, `/ws/terminal`). In the
 * bundled Tauri app this targets the loopback gateway over `ws://`; in the
 * browser and in `tauri dev` it follows the page's host + protocol (`wss://`
 * under HTTPS, preserving TLS/remote-access; the Vite proxy forwards it in dev).
 * The `path` must start with a slash; pass any query string as part of `path`.
 */
export function wsUrl(path: string): string {
  if (useAbsoluteBase()) return `ws://${TAURI_GATEWAY_HOST}${path}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
