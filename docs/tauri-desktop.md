# Conan desktop (Tauri v2) — build prerequisites

Conan v4.1 wraps the existing React + xterm UI and the Node gateway in a native
Tauri v2 desktop window. `src-tauri/` lives at the **repo root** (next to `ui/`).
This doc covers the toolchain you need to build/run the desktop app. The sidecar
packaging, origin/CSP wiring, and spawn-on-launch are layered on top of this
scaffold (see `docs/sidecar.md` for the sidecar mechanics).

## Prerequisites

1. **Rust toolchain** (stable) via [rustup](https://rustup.rs):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
   . "$HOME/.cargo/env"          # add cargo to PATH for the current shell
   cargo --version               # confirm
   ```
   On Apple Silicon the host target triple is `aarch64-apple-darwin`
   (`rustc --print host-tuple`). The sidecar binary must be named with this
   triple (US-008).

2. **Tauri CLI + JS bindings** (already in `package.json`):
   - `@tauri-apps/cli` (dev dep) — drives `tauri dev` / `tauri build`
   - `@tauri-apps/api`, `@tauri-apps/plugin-shell` (runtime)
   ```bash
   npm install                   # installs all of the above
   ```

3. **Xcode Command Line Tools** (macOS) for the C/C++ toolchain Tauri links
   against: `xcode-select --install`.

## Commands

```bash
npm run tauri:dev      # tauri dev — boots Vite (:5173) + opens the native window
npm run tauri:build    # tauri build — produces Conan.app + .dmg (US-010)
cd src-tauri && cargo check   # typecheck the Rust crate without bundling
```

`tauri dev` runs `beforeDevCommand` (`npm --prefix ui run dev`) and attaches to
the fixed Vite dev server at `http://localhost:5173`
(`server.port: 5173 + strictPort` and `clearScreen: false` in
`ui/vite.config.ts`). `tauri build` runs `beforeBuildCommand`
(`npm --prefix ui run build`) and loads the bundled frontend from `../ui/dist`
into the webview (`frontendDist`). The gateway itself is JSON-API + WebSockets
only — it does **not** serve the UI over HTTP (v4.2 Tauri-only; the gateway's
trimmed route surface is listed in `CLAUDE.md`).

## Config anchors (`src-tauri/tauri.conf.json`)

- `productName: "Conan"`, `identifier: "so.whatmatters.conan"`
- One 1400×900 window
- `bundle.targets: ["app", "dmg"]`
- `app.security.csp: null` (loopback desktop app; an explicit `connect-src`
  policy is optional)

`src-tauri/target/` is gitignored.

## Bundling the macOS app (US-010)

The desktop app ships the gateway as a **bundled-node sidecar** (research §3
approach (d)): `src-tauri/binaries/conan-gateway-<triple>` is a tiny relocatable
launcher that execs `runtime/node runtime/gateway.cjs`; the `runtime/` tree
(Node binary + esbuild'd gateway + the two native addons as real files) is copied
into the `.app` via `bundle.resources` so the launcher finds it at
`Contents/Resources/runtime` (`../Resources/runtime` from `Contents/MacOS`).

```bash
npm run build:sidecar          # 1. (re)build src-tauri/binaries/conan-gateway-<triple> + runtime/
npm run test:sidecar           # 2. prove better-sqlite3 + node-pty work from the packaged binary
CI=true npm run tauri:build    # 3. bundle Conan.app + Conan_<ver>_<arch>.dmg
```

Artifacts land under `src-tauri/target/release/bundle/{macos,dmg}/`
(`Conan.app` ≈ 189 MB, `Conan_0.1.0_aarch64.dmg` ≈ 56 MB).

- **`CI=true` is required for headless/non-GUI bundling.** The `.dmg` step runs
  `bundle_dmg.sh`, which drives Finder via AppleScript to lay out the volume
  window; with no interactive GUI session that times out (`AppleEvent timed out
  (-1712)`). `CI=true` makes Tauri pass `--sandbox-safe`, skipping the cosmetic
  AppleScript (the DMG still works — it just has no custom icon layout). On a
  normal desktop session you can omit `CI=true` to get the styled DMG.
- **Rebuild the sidecar before bundling** if `src/` changed — `beforeBuildCommand`
  only rebuilds the UI, not `conan-gateway`.

## Signing & notarization

- **Local run (ad-hoc):** `build-sidecar.mjs` ad-hoc-signs the launcher + the
  embedded `node` (`codesign -s -`) so the arm64 kernel doesn't kill them, and
  `tauri build` ad-hoc-signs the `.app`. This is enough to launch on the build
  machine. (`codesign --verify --deep --strict` reports a stale resource seal
  because `runtime/` is added as a bundle resource after the linker signature —
  harmless for local ad-hoc launch; a real Developer-ID re-sign reseals it.)
- **Distribution (Developer ID + notarize):** required or users get
  "damaged/unverified". Set the env Tauri reads and rebuild:
  ```bash
  export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
  export APPLE_ID="you@example.com"
  export APPLE_PASSWORD="app-specific-password"   # or APPLE_API_KEY/_ISSUER
  export APPLE_TEAM_ID="TEAMID"
  npm run tauri:build
  ```
  Tauri signs the `.app` (and the embedded sidecar/`node`) with the Developer ID
  and notarizes the bundle. Verify E2E that the **notarized** app still spawns the
  gateway after Gatekeeper validation (research §5). The sidecar's `node` +
  launcher are Mach-O specifically so they can carry a real signature.
