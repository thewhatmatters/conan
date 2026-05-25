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
 */
function allowedOrigins(): Set<string> {
  const defaults = [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ];
  const extra = (process.env.CONAN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...defaults, ...extra]);
}

const ALLOWED = allowedOrigins();

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
 * Validate a WebSocket upgrade request: Origin must be allow-listed and the
 * token (query param `?token=` or `Sec-WebSocket-Protocol`) must match.
 * Checked on every connection, not just the first.
 */
export function verifyUpgrade(req: IncomingMessage): AuthResult {
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED.has(origin)) {
    return { ok: false, reason: `origin not allowed: ${origin}` };
  }

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
