# Conan gateway sidecar (US-008)

The Node gateway is packaged into a self-contained **Tauri sidecar** artifact so
the desktop app (US-009/010) can spawn it on launch. Built with
`npm run build:sidecar`, verified with `npm run test:sidecar`.

## Approach: bundled-node launcher (research §3, option d)

Native `.node` addons (`better-sqlite3`, `node-pty`) **cannot** be embedded into
a snapshot/bytecode binary — they must travel as real files. So instead of a
single-file packer (`pkg`/SEA), the sidecar ships a small launcher next to a
copy of Node, the bundled gateway JS, and the native modules as files:

```
src-tauri/binaries/
  conan-gateway-<TARGET_TRIPLE>   # the sidecar binary Tauri bundles.
                                  # A tiny Mach-O C launcher (so `codesign -s -`
                                  # is meaningful on arm64) that resolves its own
                                  # dir and execs runtime/node runtime/gateway.cjs.
  runtime/
    node                          # a copy of the Node binary (the interpreter)
    gateway.cjs                   # esbuild bundle of src/gateway/index.ts
                                  #   (express/ws/app code inlined; the two native
                                  #    packages left EXTERNAL)
    schema.sql                    # db schema, read at boot via import.meta.url
    node_modules/                 # ONLY the native packages + runtime loaders:
      better-sqlite3 node-pty       kept as files so the .node addons load by
      bindings file-uri-to-path     normal Node resolution — no extraction hacks,
                                    and node-pty's spawn-helper keeps its +x bit.
  settings/                       # lazily-read JSON schema asset (settings route)
```

The whole `binaries/` tree is **gitignored** (the bundled `node` is ~108 MB);
rebuild it with `npm run build:sidecar`.

### The target-triple suffix is mandatory
Tauri's `externalBin` lookup strips the triple at bundle time and a mismatch
yields a runtime `Io NotFound`. On Apple Silicon the file is
`conan-gateway-aarch64-apple-darwin`. The build script derives the triple from
`rustc --print host-tuple`, falling back to the platform/arch when rustc is
absent.

## Native-module validation (the dominant packaging risk)
`npm run test:sidecar` runs the produced binary directly (no Tauri) and asserts:

1. **better-sqlite3** — `GET /api/health` opens the DB and queries
   `sqlite_master`; a 200 with a non-empty `tables` array proves the addon
   loaded and the schema applied.
2. **node-pty / spawn-helper** — opens a terminal WS, runs `echo`, and confirms
   the output returns. That requires `pty.spawn → posix_spawnp` via the
   `spawn-helper`, the executable that classically loses its `+x` bit after
   packaging (`posix_spawnp failed`). The build script re-asserts `chmod 0755`
   on every prebuild's `spawn-helper` defensively.

## Code signing

- **Local run (now):** the launcher and the bundled `node` are **ad-hoc**
  signed (`codesign --force -s - <bin>`) by the build script. Without this the
  arm64 kernel kills a locally-modified Mach-O.
- **Distribution (required for shipping):** ad-hoc is **not** enough — macOS
  Gatekeeper will report the app as "damaged/unverified" on another machine. A
  paid **Apple Developer ID** is required to:
  1. code-sign the `.app` **and** the embedded sidecar with the Developer-ID
     Application identity, then
  2. **notarize** the bundle (`xcrun notarytool`) and staple it.
  Test the notarized build end-to-end — the embedded gateway must still spawn
  after Gatekeeper validation (known externalBin + notarization ordering issue,
  tauri#11992). See `docs/v4.1-research.md` §5.

## Rebuild / re-verify
```bash
npm run build:sidecar   # esbuild bundle + stage node/native modules + sign
npm run test:sidecar    # run the binary, prove both native addons work
```
