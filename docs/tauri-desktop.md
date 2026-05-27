# Conan desktop (Tauri v2) — build prerequisites

Conan v4.1 wraps the existing React + xterm UI and the Node gateway in a native
Tauri v2 desktop window. `src-tauri/` lives at the **repo root** (next to `ui/`).
This doc covers the toolchain you need to build/run the desktop app. The sidecar
packaging (US-008+), origin/CSP wiring (US-006/007), and spawn-on-launch
(US-009) are layered on top of this scaffold; see `docs/v4.1-research.md`.

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
(`npm --prefix ui run build`) and serves `../ui/dist`.

## Config anchors (`src-tauri/tauri.conf.json`)

- `productName: "Conan"`, `identifier: "so.whatmatters.conan"`
- One 1400×900 window
- `bundle.targets: ["app", "dmg"]`
- `app.security.csp: null` (loopback desktop app; see `docs/v4.1-research.md` §4
  for the optional explicit `connect-src` policy)

`src-tauri/target/` is gitignored.
