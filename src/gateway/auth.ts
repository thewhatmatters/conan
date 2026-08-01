import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { DATA_DIR } from "../paths.js";

const TOKEN_FILE = path.join(DATA_DIR, "auth-token");
const PORT = Number(process.env.CONAN_PORT ?? 3747);

/**
 * Resolve the gateway auth token (US-002). Precedence:
 *  1. CONAN_AUTH_TOKEN env var
 *  2. persisted .data/auth-token (stable across restarts)
 *  3. freshly generated, then persisted
 * The same-origin SPA reads it via GET /api/config; cross-origin pages cannot
 * read that response (no CORS), so the token isn't exposed to the web.
 */
export function getAuthToken(): string {
  const fromEnv = process.env.CONAN_AUTH_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not yet created */
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

const AUTH_TOKEN = getAuthToken();

/**
 * Origins allowed to open a WebSocket. Browsers do NOT apply same-origin policy
 * to WS connections (the root cause of CVE-2025-52882), so we validate Origin
 * ourselves. Defaults cover the gateway itself and the Vite dev server; extend
 * via CONAN_ALLOWED_ORIGINS (comma-separated).
 *
 * This list is no longer the whole rule: `isLoopbackOrigin` below also accepts
 * any http(s) loopback origin, so a dev/preview stack on a non-5173 port works
 * without configuration. The entries here still matter for the non-loopback
 * `tauri://` schemes and for anything an operator adds explicitly.
 */
function allowedOrigins(): Set<string> {
  const defaults = [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    // Tauri webview origins (US-007, v4.1 desktop shell). Browsers don't apply
    // same-origin policy to WS, so the desktop webview's Origin must be listed
    // explicitly or its app/terminal WS upgrades are rejected (CVE-2025-52882
    // floor unchanged — bogus origins still fail). Production macOS sends
    // tauri://localhost; Windows/Android use https://tauri.localhost. We allow
    // all three for cross-platform/future-proofing.
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ];
  const extra = (process.env.CONAN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...defaults, ...extra]);
}

const ALLOWED = allowedOrigins();

/**
 * True for an `http(s)` origin whose host is loopback (WHA-8). The explicit list
 * above pins the Vite dev origin to :5173, so every preview or review stack on
 * any other port failed the upgrade — the page loaded (HTTP is proxied) but
 * `/ws/agent` was refused and the UI painted "connection lost". That cost real
 * debugging time more than once.
 *
 * Widening to *any* loopback port does not lower the CVE-2025-52882 floor. That
 * attack is a REMOTE page opening a socket to localhost, and a browser sets
 * `Origin` itself — a page on evil.com cannot claim `http://127.0.0.1:5230`, so
 * it is still refused here. What now passes is only a page already served from
 * this machine's loopback interface, which the token check gates a second time
 * (`/api/config` sends no CORS headers, so a cross-origin page cannot read it).
 *
 * Host matching is exact, via the URL parser rather than a prefix test, so
 * lookalikes like `http://127.0.0.1.evil.com` and `http://localhost.evil.com`
 * do not match. The scheme is restricted to http(s) so the `tauri://` origins
 * keep going through the explicit list above and nothing else rides in on a
 * custom scheme that happens to use a loopback host.
 */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // not a parseable origin — no opinion, so no access
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname;
  if (host === "localhost" || host === "[::1]") return true;

  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  return parts[0] === 127 && parts.every((n) => n <= 255);
}

/** The one Origin decision both the WS upgrade and the CORS reflector use. */
function originAllowed(origin: string): boolean {
  return ALLOWED.has(origin) || isLoopbackOrigin(origin);
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

/**
 * Predicate version of the Origin allow-list for the HTTP CORS reflector
 * (v4.6 hotfix). The HTTP fetch path needs the same allow-list the WS upgrade
 * uses so the bundled Tauri webview (`tauri://localhost`) can read `/api/*`
 * cross-origin — modern WKWebView enforces CORS strictly on `tauri://` →
 * `http://127.0.0.1` and blocks unflagged responses, leaving the UI stuck on
 * "connecting…". Used by the gateway's `corsReflect` middleware; the security
 * floor is unchanged (same allow-list, no wildcard).
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return originAllowed(origin);
}

/**
 * Validate the Origin of a WebSocket upgrade against the allow-list. Split out
 * from verifyUpgrade so the live-preview proxy (US-011) can gate /preview/ HMR
 * upgrades on Origin alone: that WebSocket originates inside Conan's same-origin
 * iframe and cannot attach the x-conan-token (an <iframe src> sets no custom
 * headers; Vite supplies its own end-to-end HMR token instead). This is the
 * documented security floor — same-origin + loopback + Origin-checked upgrade.
 */
export function verifyUpgradeOrigin(req: IncomingMessage): AuthResult {
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin)) {
    return { ok: false, reason: `origin not allowed: ${origin}` };
  }
  return { ok: true };
}

/**
 * Validate a WebSocket upgrade request: Origin must be allow-listed and the
 * token (query param `?token=` or `Sec-WebSocket-Protocol`) must match.
 * Checked on every connection, not just the first.
 */
export function verifyUpgrade(req: IncomingMessage): AuthResult {
  const origin = verifyUpgradeOrigin(req);
  if (!origin.ok) return origin;

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const token =
    url.searchParams.get("token") ??
    req.headers["sec-websocket-protocol"]?.toString();

  if (!token || !timingSafeEqual(token, AUTH_TOKEN)) {
    return { ok: false, reason: "invalid or missing token" };
  }
  return { ok: true };
}

export { AUTH_TOKEN };
