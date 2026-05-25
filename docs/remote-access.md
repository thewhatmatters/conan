# Remote access (US-024)

Conan is **loopback-only by default** — it binds `127.0.0.1:3747` and is not
reachable from any other device. Remote access is **opt-in** and only over TLS.

## How it works

When you set both `CONAN_TLS_CERT` and `CONAN_TLS_KEY` to a certificate/key
pair, the gateway runs as **HTTPS** and every WebSocket — both the app event
stream (`/ws`) and the **interactive terminal** (`/ws/terminal`) — is served
over `wss://` behind that TLS layer. There is **no separate shell/terminal
port**: the pty rides the same authenticated WebSocket upgrade as everything
else, so it can never be reached as a raw, unauthenticated socket.

Every upgrade is still gated by the existing security baseline (US-002):

- **Token auth** — the SPA reads the token from same-origin `/api/config`;
  WebSocket clients present it as `?token=` (or `Sec-WebSocket-Protocol`).
- **Origin allowlist** — required because browsers don't apply same-origin
  policy to WebSockets (CVE-2025-52882).

## Turning it on

1. Obtain a cert + key for the hostname you'll reach Conan at. For a quick
   self-signed pair (LAN / behind a VPN):

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout conan-key.pem -out conan-cert.pem \
     -days 365 -subj "/CN=your-host" \
     -addext "subjectAltName=DNS:your-host"
   ```

2. Start the gateway in remote mode:

   ```bash
   CONAN_TLS_CERT=/path/conan-cert.pem \
   CONAN_TLS_KEY=/path/conan-key.pem \
   CONAN_HOST=0.0.0.0 \
   CONAN_ALLOWED_ORIGINS=https://your-host:3747 \
   npm start
   ```

   - `CONAN_HOST=0.0.0.0` exposes it on the network. The gateway **refuses to
     bind a non-loopback host unless TLS is configured** — so you can't
     accidentally serve the dashboard (or the terminal) in cleartext.
   - `CONAN_ALLOWED_ORIGINS` must include the exact `https://host:port` the
     browser will use. The loopback `https://127.0.0.1:PORT` and
     `https://localhost:PORT` origins are allow-listed automatically in TLS mode.

3. The boot log confirms it:
   `remote TLS mode ON … WebSockets served over wss://`.

## Notes

- A **half-configured** pair (only one of cert/key set) fails loud at boot
  rather than silently falling back to plaintext.
- For exposure beyond a trusted LAN, terminate TLS at a reverse proxy with a
  real cert, or front Conan with an authenticated encrypted relay
  ([slopus/happy](https://github.com/slopus/happy) model) — the same
  token + Origin checks apply regardless of how the wss:// reaches the gateway.
- Implementation: `src/gateway/tls.ts` (config + the non-loopback-without-TLS
  guard), wired in `src/gateway/index.ts`. Covered by `scripts/test-tls.mjs`.
