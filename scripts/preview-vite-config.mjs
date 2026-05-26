// Conan live-preview HMR shim (US-011).
//
// The preview backend (src/preview/index.ts) spawns the user's Vite dev server
// with `--config <this file>` so HMR dials back THROUGH Conan's reverse proxy
// instead of the Vite client's default behaviour (silently connecting straight
// to the dev-server port, which bypasses Conan's auth and breaks when framed).
//
// We do NOT edit the user's vite config: we load it ourselves and merge a small
// `server.hmr` overlay on top. Everything (plugins, aliases, the user's own
// server.proxy, etc.) is preserved. Parameters arrive via env so this file is
// static and reusable across previews:
//
//   CONAN_PREVIEW_ROOT          the project dir whose vite.config.* to load
//   CONAN_PREVIEW_CLIENT_PORT   the public Conan port the HMR client must dial
//   CONAN_PREVIEW_HMR_PATH      the WS path under /preview/<id>/ to route HMR on
//   CONAN_PREVIEW_HMR_PROTOCOL  "ws" | "wss" (wss when Conan runs under TLS)
//
// `vite` is imported dynamically and resolved from the PROJECT's node_modules
// (this shim lives in Conan's repo, which doesn't depend on vite) — a static
// `import "vite"` would resolve against the wrong node_modules and fail.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

export default async (configEnv) => {
  const root = process.env.CONAN_PREVIEW_ROOT || process.cwd();

  // Resolve vite from the project being previewed, then import its ESM entry.
  const require = createRequire(path.join(root, "package.json"));
  const { loadConfigFromFile, mergeConfig } = await import(
    pathToFileURL(require.resolve("vite")).href
  );

  // Load the project's own vite config (if any) so its plugins/aliases survive.
  // A missing or unreadable config is fine — we just apply the HMR overlay.
  let userConfig = {};
  try {
    const loaded = await loadConfigFromFile(configEnv, undefined, root);
    if (loaded && loaded.config) userConfig = loaded.config;
  } catch {
    /* no/invalid user config — overlay-only */
  }

  const clientPort = Number(process.env.CONAN_PREVIEW_CLIENT_PORT);
  const hmrPath = process.env.CONAN_PREVIEW_HMR_PATH || undefined;
  const protocol = process.env.CONAN_PREVIEW_HMR_PROTOCOL || undefined;

  const overlay = {
    root,
    server: {
      hmr: {
        // The browser loaded the page from Conan's origin, so HMR must dial the
        // Conan port + a /preview/ path (proxied to the dev server) — not the
        // raw dev-server port the Vite client would otherwise guess.
        clientPort: Number.isFinite(clientPort) ? clientPort : undefined,
        path: hmrPath,
        protocol,
      },
    },
  };

  return mergeConfig(userConfig, overlay);
};
