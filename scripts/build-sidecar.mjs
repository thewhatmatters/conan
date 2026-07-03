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
  readFileSync,
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
//    CJS bundle resolves to runtime/schema.sql. (The trimmed v4.2 gateway has no
//    other lazily-read schema assets — the settings/hooks-coverage routes that
//    needed claude-code-settings.schema.json were removed in US-004.)
cpSync(
  path.join(ROOT, "src", "db", "schema.sql"),
  path.join(RUNTIME, "schema.sql"),
);

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
//    Also strip non-darwin-arm64 prebuilds — node-pty ships win32-* and
//    darwin-x64 that we don't run, and Apple's notarization rejects the
//    bundle when those unsigned Mach-O slip past (a build-time prune is
//    safer than per-binary signing of dead weight).
const ptyPrebuilds = path.join(nm, "node-pty", "prebuilds");
if (existsSync(ptyPrebuilds)) {
  for (const dir of readdirSync(ptyPrebuilds)) {
    if (dir !== "darwin-arm64") {
      rmSync(path.join(ptyPrebuilds, dir), { recursive: true, force: true });
      continue;
    }
    const helper = path.join(ptyPrebuilds, dir, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// 5b. Bundle conan-cli (the spec-first setup menu, Conan 1.2.0). The gateway
//     launches it in claude-mode ptys when the Settings toggle is on:
//     `<runtime>/node <runtime>/conan-cli/dist/index.js`. Copied as real files
//     (not esbuild-bundled): figlet resolves its .flf fonts from disk relative
//     to its own package dir, and conan-cli's skill installer copies
//     `skills/` + `methods/` out of the package root at run time — both break
//     under inlining. Pure-JS deps only, so unlike the native modules above
//     there is no codesign concern; we just prune the figlet font library
//     (~20 MB) down to the fonts the splash actually uses.
const CLI_SRC = process.env.CONAN_CLI_DIR || path.join(ROOT, "..", "conan-cli");
const CLI_OUT = path.join(RUNTIME, "conan-cli");
if (!existsSync(path.join(CLI_SRC, "dist", "index.js"))) {
  throw new Error(
    `conan-cli dist not found at ${CLI_SRC} — run \`npm run build\` there first ` +
      "(or point CONAN_CLI_DIR at a built checkout).",
  );
}
console.log(`[sidecar] bundling conan-cli from ${path.relative(ROOT, CLI_SRC)} …`);
for (const piece of ["dist", "methods", "skills", "package.json"]) {
  cpSync(path.join(CLI_SRC, piece), path.join(CLI_OUT, piece), {
    recursive: true,
  });
}
// Prod dependency closure, walked from package.json through node_modules —
// deterministic and offline (no npm install at build time).
const cliDeps = (() => {
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const seen = new Set();
  const stack = Object.keys(read(path.join(CLI_SRC, "package.json")).dependencies ?? {});
  while (stack.length > 0) {
    const mod = stack.pop();
    if (seen.has(mod)) continue;
    seen.add(mod);
    const pj = path.join(CLI_SRC, "node_modules", mod, "package.json");
    if (existsSync(pj)) stack.push(...Object.keys(read(pj).dependencies ?? {}));
  }
  return [...seen].sort();
})();
console.log(`[sidecar] conan-cli deps: ${cliDeps.join(", ")}`);
for (const mod of cliDeps) {
  const from = path.join(CLI_SRC, "node_modules", mod);
  if (!existsSync(from)) throw new Error(`conan-cli missing node_modules/${mod}`);
  cpSync(from, path.join(CLI_OUT, "node_modules", mod), { recursive: true });
}
// Keep only the splash's font ladder (src/splash.ts FONTS) — the rest of
// figlet's library is dead weight in the .app.
const CLI_FONTS = ["ANSI Shadow.flf", "Block.flf", "Colossal.flf"];
const fontsDir = path.join(CLI_OUT, "node_modules", "figlet", "fonts");
if (existsSync(fontsDir)) {
  for (const f of readdirSync(fontsDir)) {
    if (!CLI_FONTS.includes(f)) rmSync(path.join(fontsDir, f), { force: true });
  }
}
// figlet also ships a 12 MB browser-oriented JS mirror of the font library
// (importable-fonts/); the Node loader never touches it.
rmSync(path.join(CLI_OUT, "node_modules", "figlet", "importable-fonts"), {
  recursive: true,
  force: true,
});

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

// 7. Codesign the launcher + the embedded node. The arm64 kernel refuses to
//    exec unsigned/locally-modified Mach-O at all — ad-hoc is the dev baseline.
//    For a release build, scripts/release.mjs sets APPLE_SIGNING_IDENTITY +
//    APPLE_ENTITLEMENTS so the same binaries arrive pre-signed with the
//    hardened runtime; Tauri's later `--deep` re-sign then leaves them alone
//    (and notarization needs all nested Mach-O signed with the SAME identity).
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || "-";
const entitlements = process.env.APPLE_ENTITLEMENTS || null;
const useDeveloperId = signingIdentity !== "-";

if (useDeveloperId) {
  console.log(`[sidecar] codesigning with: ${signingIdentity}`);
  if (!entitlements) {
    throw new Error(
      "APPLE_SIGNING_IDENTITY set but APPLE_ENTITLEMENTS isn't — refusing to ship a Developer-ID-signed binary without the hardened-runtime entitlements (notarization would reject it). scripts/release.mjs should set both.",
    );
  }
} else {
  console.log("[sidecar] ad-hoc codesigning …");
}

// Walk every Mach-O under runtime/: node + launcher + every .node addon +
// node-pty's spawn-helper. Apple's notarization scans recursively and rejects
// the bundle if ANY embedded Mach-O is missing a Developer ID signature, a
// secure timestamp, or the hardened runtime — there is no "skip nested" knob.
// Inner binaries are signed FIRST so the outer .app sign-pass (Tauri does it
// at bundle time) has valid nested sigs to seal over.
function walkMachO(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkMachO(p));
    } else if (name.isFile()) {
      // Identify by extension/name; cheap and stable. (`spawn-helper` is the
      // only Mach-O without a `.node` / well-known name.) `node` and the
      // launcher are captured by name.
      if (
        p.endsWith(".node") ||
        path.basename(p) === "spawn-helper" ||
        p === path.join(RUNTIME, "node") ||
        p === LAUNCHER
      ) {
        out.push(p);
      }
    }
  }
  return out;
}

const targets = walkMachO(RUNTIME);
console.log(`[sidecar] codesigning ${targets.length} Mach-O binaries`);
for (const bin of targets) {
  const args = ["--force", "-s", signingIdentity];
  if (useDeveloperId) {
    args.push("--options", "runtime", "--timestamp");
    if (entitlements) args.push("--entitlements", entitlements);
  }
  args.push(bin);
  const r = spawnSync("codesign", args, { encoding: "utf8" });
  if (r.status !== 0) {
    const msg = `[sidecar] codesign ${useDeveloperId ? "FAILED" : "warning"} for ${bin}: ${r.stderr?.trim()}`;
    if (useDeveloperId) throw new Error(msg);
    console.warn(msg);
  }
}

console.log(`\n[sidecar] done → ${path.relative(ROOT, LAUNCHER)}`);
console.log(
  "[sidecar] verify it directly with: npm run test:sidecar (no Tauri).",
);
