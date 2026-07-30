import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import stylex from "unplugin-stylex/vite";

// Dev server proxies API + WS to the gateway on :3747. Both the gateway port and
// the dev-server port can be overridden via env (CONAN_PORT / CONAN_UI_PORT) so a
// throwaway dev instance can run alongside the packaged app without clobbering it.
const GATEWAY_PORT = process.env.CONAN_PORT || "3747";
const UI_PORT = Number(process.env.CONAN_UI_PORT) || 5173;

function currentBranch() {
  if (process.env.VITE_BRANCH_NAME) return process.env.VITE_BRANCH_NAME;
  try {
    return execSync("git branch --show-current", { cwd: "..", encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  // StyleX compiler (T0 · docs/v2-astryx-redesign.md §8). Astryx COMPONENTS
  // ship pre-compiled and need no plugin — but v2 authors its own styles with
  // `stylex.create()` for the `xstyle` prop, and that throws at runtime unless
  // a build-time compiler rewrites it ("Unexpected 'stylex.create' call at
  // runtime"), so the plugin is required, not optional. It is a no-op for v1:
  // no v1 file calls stylex.
  plugins: [
    react(),
    tailwindcss(),
    stylex(),
    {
      name: "agent-title",
      transformIndexHtml(html) {
        const agent = process.env.VITE_AGENT_NAME || "Conan";
        const branch = currentBranch();
        return html.replace("<title>Conan</title>", `<title>Conan-${agent} (${branch})</title>`);
      },
    },
  ],
  // Don't clear the screen so Tauri's dev output stays visible when it
  // attaches to this dev server.
  clearScreen: false,
  resolve: {
    // Force a single React instance. Astryx hooks (e.g. useListFocus in
    // SurfaceTabs) are pre-bundled from @astryxdesign/core and would otherwise
    // resolve their own React copy, triggering "Invalid hook call — more than
    // one copy of React" under Vite dep-optimization + unplugin-stylex.
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Fixed port so `tauri dev` can attach to a known devUrl.
    port: UI_PORT,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${GATEWAY_PORT}`,
      "/ws": { target: `ws://127.0.0.1:${GATEWAY_PORT}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
