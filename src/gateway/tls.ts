// US-024: opt-in remote access over TLS (wss://) with token auth.
//
// Conan is loopback-only by default (see src/gateway/index.ts). To reach the
// dashboard from another device you opt in by pointing CONAN_TLS_CERT and
// CONAN_TLS_KEY at a certificate + key pair; the gateway then runs as HTTPS and
// every WebSocket (the app stream AND the terminal pty) is served over wss://
// behind that TLS layer. The existing token + Origin checks (US-002) still gate
// every upgrade, so the terminal is never reachable as a raw, unauthenticated
// socket — there is no separate shell port to expose.
//
// Nothing here changes behaviour unless the cert/key env vars are set, so the
// default posture stays loopback-only with no TLS.
import fs from "node:fs";
import type { ServerOptions } from "node:https";

export interface TlsConfig {
  /** True when both cert + key resolved — i.e. remote TLS mode is on. */
  enabled: boolean;
  /** HTTPS server options (cert + key buffers), present iff `enabled`. */
  options?: ServerOptions;
  /** Resolved paths, for logging / diagnostics. */
  certPath?: string;
  keyPath?: string;
}

/**
 * Resolve TLS config from the environment. Remote mode is **off by default**:
 * it turns on only when both CONAN_TLS_CERT and CONAN_TLS_KEY point at readable
 * files. A half-configured pair (one set, the other missing/unreadable) throws
 * so a typo fails loud at boot instead of silently falling back to plaintext on
 * a network interface.
 */
export function resolveTlsConfig(env: NodeJS.ProcessEnv = process.env): TlsConfig {
  const certPath = env.CONAN_TLS_CERT?.trim();
  const keyPath = env.CONAN_TLS_KEY?.trim();

  if (!certPath && !keyPath) return { enabled: false };

  if (!certPath || !keyPath) {
    throw new Error(
      "TLS misconfigured: set BOTH CONAN_TLS_CERT and CONAN_TLS_KEY (or neither).",
    );
  }

  let cert: Buffer;
  let key: Buffer;
  try {
    cert = fs.readFileSync(certPath);
  } catch {
    throw new Error(`TLS cert not readable: ${certPath}`);
  }
  try {
    key = fs.readFileSync(keyPath);
  } catch {
    throw new Error(`TLS key not readable: ${keyPath}`);
  }

  return { enabled: true, options: { cert, key }, certPath, keyPath };
}

/** A loopback bind address that browsers reach without crossing the network. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Guard against accidentally exposing the dashboard in plaintext: binding to a
 * non-loopback interface (i.e. making it reachable from other devices) requires
 * TLS to be configured. Loopback binds are always fine (TLS optional). Throws a
 * clear message rather than quietly serving cleartext + an auth token on a LAN.
 */
export function assertRemoteSafe(host: string, tls: TlsConfig): void {
  if (isLoopbackHost(host)) return;
  if (!tls.enabled) {
    throw new Error(
      `Refusing to bind ${host} without TLS: remote access requires CONAN_TLS_CERT + ` +
        `CONAN_TLS_KEY (wss://). Keep CONAN_HOST on loopback for local-only use.`,
    );
  }
}
