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
  `tauri build` ad-hoc-signs the `.app`. Enough to launch on the build machine.

- **Distribution (Developer ID + notarize):** required or users get
  "damaged/unverified". One command:

  ```bash
  npm run release
  ```

  [scripts/release.mjs](../scripts/release.mjs) is the locked release flow.
  It:
  1. Kills any running `Conan.app` (a live gateway writes to its own
     `Contents/Resources/.claude/` → invalidates the resource seal).
  2. Resolves the Developer ID identity from the Keychain (Team ID
     `4P6GX328VY` for this project).
  3. Confirms the `conan-notarize` notarytool keychain profile authenticates.
  4. Rebuilds the sidecar with `APPLE_SIGNING_IDENTITY` + `--options runtime`
     + `--timestamp` + the entitlements file — signing **every** Mach-O under
     `runtime/` (the `.node` addons, `spawn-helper`, the embedded `node`, the
     launcher). Apple's notarization scans recursively and rejects any nested
     binary missing a Developer ID sig, secure timestamp, or hardened runtime.
  5. Runs `tauri build` with the same env so Tauri's `--deep` re-sign seals
     the outer bundle.
  6. **Scrubs any `.claude/.data/.DS_Store` stray state** from
     `Conan.app/Contents/Resources/` and re-signs (defensive — guards against
     a race where macOS or a curious process touches the bundle between sign
     and notarize).
  7. Zips + submits the `.app` to `notarytool` with
     `--keychain-profile conan-notarize --wait`. ~5 min round-trip.
  8. Staples the ticket to the `.app`.
  9. Regenerates the `.dmg` from the **stapled** `.app` using `hdiutil`
     (the Tauri-built `.dmg` was created before the staple, so its hash is
     stale and `notarytool` would reject the .app inside).
  10. Submits the new `.dmg` to `notarytool`, staples it.
  11. `spctl --assess` verifies both artifacts read
      `source=Notarized Developer ID`.

  **One-time setup (per developer):**

  ```bash
  # 1. Developer ID Application cert in Keychain — create in Xcode:
  #    Settings ▸ Accounts ▸ Manage Certificates ▸ + ▸ Developer ID Application
  security find-identity -v -p codesigning   # confirm

  # 2. App-specific password stored under the `conan-notarize` profile
  xcrun notarytool store-credentials conan-notarize \
    --apple-id "<your-apple-id>" \
    --team-id "4P6GX328VY"

  # 3. Verify auth works (clean "No submission history" means success)
  xcrun notarytool history --keychain-profile conan-notarize
  ```

  The password lives only in your login Keychain — never in env vars, never
  in this repo, never in CI logs. The release script reads it through
  `xcrun notarytool --keychain-profile`, which can decrypt the item without
  the password leaving Apple's API surface.

### Hardened-runtime entitlements

[src-tauri/Conan.entitlements](../src-tauri/Conan.entitlements) declares the
minimal set Apple's hardened runtime needs for Conan to function:

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | WKWebView's V8 needs writable-then-executable memory pages for JIT. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Backup for JIT pages allocated outside the explicit JIT mmap path. |
| `com.apple.security.cs.disable-library-validation` | npm-shipped native addons (`better-sqlite3.node`, `pty.node`) are signed by their packagers, not by our Team ID — Library Validation would refuse to load them. |
| `com.apple.security.cs.allow-dyld-environment-variables` | `node-pty` forks `spawn-helper`, which inherits some env. |

If a future feature needs another entitlement, add it here AND re-submit for
notarization — Apple flags new entitlements per submission.

### What lives where

- The Developer ID Application cert: in your **login Keychain**. Visible via
  `security find-identity -v -p codesigning`.
- The app-specific password for `notarytool`: in your **login Keychain**
  under the `conan-notarize` notarytool profile. Apple's system manages the
  storage; `security find-generic-password` can't see it.
- The Team ID `4P6GX328VY`: hardcoded in [scripts/release.mjs](../scripts/release.mjs).
- The Apple ID email: same.
- The signing identity name: derived at runtime from `security find-identity`.
