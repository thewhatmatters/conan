// Build the Conan gateway into a self-contained Tauri *sidecar* artifact
// (US-008). The "bundled-node launcher" approach (see docs/sidecar.md) — the
// most reliable route for native addons:
//
//   src-tauri/binaries/
//     conan-gateway-<TARGET_TRIPLE>     <- the sidecar binary Tauri bundles
//                                          (a tiny C launcher; Mach-O so it can
//                                          be ad-hoc codesigned on arm64)
//     runtime/
//       node                            <- a copy of the Node binary
//       gateway.cjs                     <- esbuild bundle of src/gateway/index.ts
//                                          (pure-JS deps inlined; native addons
//                                          left external)
//       schema.sql                      <- read at boot via import.meta.url
//       node_modules/                   <- ONLY the native packages + their
//         better-sqlite3 node-pty          runtime loaders, kept as files on
//         bindings file-uri-to-path        disk so the .node addons load by
//                                          normal Node resolution (no extraction
//                                          hacks, spawn-helper keeps its +x bit)
//
// The launcher resolves its own directory and execs `runtime/node
// runtime/gateway.cjs`, so the whole tree relocates as a unit. Native modules
// (the two things most likely to break post-bundle per the research) are NOT
// embedded into a snapshot — they travel as real files, which is why this route
// survives node-pty's spawn-helper and better-sqlite3's .node.
//
// Run: `npm run build:sidecar`  (then verify with `npm run test:sidecar`).

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src-tauri", "binaries");
const RUNTIME = path.join(OUT, "runtime");

/** The Rust/Tauri target triple — the sidecar file MUST carry this suffix or
 *  Tauri's externalBin lookup yields a runtime `Io NotFound` (research §2). */
function targetTriple() {
  const fromRustc = spawnSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  });
  if (fromRustc.status === 0) return fromRustc.stdout.trim();
  // rustc absent on this host — derive the macOS triple from arch.
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  }
  throw new Error(
    `Cannot derive target triple on ${process.platform}/${process.arch}; install rustup.`,
  );
}

const TRIPLE = targetTriple();
const LAUNCHER = path.join(OUT, `conan-gateway-${TRIPLE}`);

/** Relocatable C launcher. Locates the runtime/ tree and execs
 *  <runtime>/node <runtime>/gateway.cjs, forwarding argv and inheriting env.
 *
 *  The runtime tree does NOT always sit next to the launcher: Tauri's
 *  externalBin relocates only the single triple-stripped binary (to
 *  target/debug|release/ in dev, Contents/MacOS/ in a .app), leaving runtime/
 *  behind. So we resolve it in this order:
 *    1. $CONAN_GATEWAY_DIR    — absolute path the Tauri host passes in dev
 *                               (src-tauri/src/lib.rs, debug only).
 *    2. <exedir>/runtime      — sibling layout (running the binary in place,
 *                               e.g. scripts/test-sidecar.mjs).
 *    3. <exedir>/../Resources/runtime — macOS .app bundle layout (the binary in
 *                               Contents/MacOS, runtime/ a bundled Resource).
 */
const LAUNCHER_C = `#include <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv, char **envp) {
  char selfpath[PATH_MAX];
  uint32_t size = sizeof(selfpath);
  if (_NSGetExecutablePath(selfpath, &size) != 0) {
    fprintf(stderr, "conan-gateway: cannot resolve own path\\n");
    return 70;
  }
  char real[PATH_MAX];
  if (realpath(selfpath, real) == NULL) {
    fprintf(stderr, "conan-gateway: realpath failed\\n");
    return 70;
  }
  char *exedir = dirname(real);

  // Resolve the runtime/ dir holding node + gateway.cjs (see comment above).
  char rtdir[PATH_MAX];
  const char *env_dir = getenv("CONAN_GATEWAY_DIR");
  if (env_dir && env_dir[0]) {
    snprintf(rtdir, sizeof(rtdir), "%s", env_dir);
  } else {
    char probe[PATH_MAX];
    snprintf(rtdir, sizeof(rtdir), "%s/runtime", exedir);
    snprintf(probe, sizeof(probe), "%s/node", rtdir);
    if (access(probe, X_OK) != 0) {
      snprintf(rtdir, sizeof(rtdir), "%s/../Resources/runtime", exedir);
    }
  }

  char node[PATH_MAX], script[PATH_MAX];
  snprintf(node, sizeof(node), "%s/node", rtdir);
  snprintf(script, sizeof(script), "%s/gateway.cjs", rtdir);

  // Build argv: node, gateway.cjs, <forwarded args...>, NULL.
  char **child = calloc(argc + 2, sizeof(char *));
  if (!child) return 71;
  child[0] = node;
  child[1] = script;
  for (int i = 1; i < argc; i++) child[i + 1] = argv[i];
  child[argc + 1] = NULL;

  execve(node, child, envp);
  perror("conan-gateway: execve failed");
  return 72;
}
`;

// Native packages: left external in the bundle, shipped as files on disk.
const NATIVE_MODULES = [
  "better-sqlite3",
  "node-pty",
  "bindings", // better-sqlite3's addon locator
  "file-uri-to-path", // bindings' only runtime dep
];
// Marked external so esbuild never tries to inline their .node / dynamic
// requires — they resolve from runtime/node_modules at run time.
const EXTERNAL = ["better-sqlite3", "node-pty", "bindings"];

console.log(`[sidecar] target triple: ${TRIPLE}`);
console.log(`[sidecar] cleaning ${path.relative(ROOT, RUNTIME)}`);
rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });

// 1. Bundle the gateway (pure-JS deps inlined, native addons external).
console.log("[sidecar] bundling gateway with esbuild …");
await esbuild({
  entryPoints: [path.join(ROOT, "src", "gateway", "index.ts")],
  outfile: path.join(RUNTIME, "gateway.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: EXTERNAL,
  logLevel: "warning",
  // CJS output has no native `import.meta`; esbuild would otherwise replace it
  // with `{}` (import.meta.url → undefined, breaking paths.ts/db schema reads).
  // Point it at the bundle's own file URL via __filename, so import.meta.url
  // resolves to runtime/gateway.cjs and SCHEMA_PATH lands at runtime/schema.sql
  // (copied below).
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "importMetaUrl" },
});

// 2. Boot-critical asset: db/schema.sql is read via import.meta.url, which the
//    CJS bundle resolves to runtime/schema.sql.
cpSync(
  path.join(ROOT, "src", "db", "schema.sql"),
  path.join(RUNTIME, "schema.sql"),
);
// Lazily-read schemas (settings / hooks-coverage endpoints). Placed at the two
// locations their import.meta.url computations resolve to, so those routes
// don't 500 in the packaged gateway.
const settingsSchema = path.join(
  ROOT,
  "src",
  "settings",
  "claude-code-settings.schema.json",
);
if (existsSync(settingsSchema)) {
  cpSync(settingsSchema, path.join(RUNTIME, "claude-code-settings.schema.json"));
  mkdirSync(path.join(OUT, "settings"), { recursive: true });
  cpSync(
    settingsSchema,
    path.join(OUT, "settings", "claude-code-settings.schema.json"),
  );
}

// 3. Ship a Node binary so the launcher has an interpreter to exec.
console.log("[sidecar] copying node binary …");
cpSync(process.execPath, path.join(RUNTIME, "node"));
chmodSync(path.join(RUNTIME, "node"), 0o755);

// 4. The native packages as real files (preserves perms incl. spawn-helper +x).
console.log("[sidecar] copying native node_modules …");
const nm = path.join(RUNTIME, "node_modules");
mkdirSync(nm, { recursive: true });
for (const mod of NATIVE_MODULES) {
  const from = path.join(ROOT, "node_modules", mod);
  if (!existsSync(from)) throw new Error(`missing node_modules/${mod}`);
  cpSync(from, path.join(nm, mod), { recursive: true });
}

// 5. The node-pty spawn-helper footgun: keep its +x bit (research §3 / the
//    posix_spawnp failure). cpSync preserves perms, but re-assert defensively.
const ptyPrebuilds = path.join(nm, "node-pty", "prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const dir of readdirSync(ptyPrebuilds)) {
    const helper = path.join(ptyPrebuilds, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// 6. Compile the launcher: a relocatable Mach-O that execs runtime/node
//    runtime/gateway.cjs. Mach-O (not a shell script) so `codesign -s -` is
//    meaningful on arm64.
console.log("[sidecar] compiling launcher …");
const launcherSrc = path.join(RUNTIME, "launcher.c");
writeFileSync(launcherSrc, LAUNCHER_C);
execFileSync(
  "clang",
  ["-O2", "-o", LAUNCHER, launcherSrc, "-framework", "CoreFoundation"],
  { stdio: "inherit" },
);
rmSync(launcherSrc);
chmodSync(LAUNCHER, 0o755);

// 7. Ad-hoc codesign the launcher + the embedded node (arm64 kernel kills
//    unsigned/locally-modified Mach-O). Distribution needs a Developer ID +
//    notarization (see docs/tauri-desktop.md).
console.log("[sidecar] ad-hoc codesigning …");
for (const bin of [path.join(RUNTIME, "node"), LAUNCHER]) {
  const r = spawnSync("codesign", ["--force", "-s", "-", bin], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.warn(`[sidecar] codesign warning for ${bin}: ${r.stderr?.trim()}`);
  }
}

console.log(`\n[sidecar] done → ${path.relative(ROOT, LAUNCHER)}`);
console.log(
  "[sidecar] verify it directly with: npm run test:sidecar (no Tauri).",
);
