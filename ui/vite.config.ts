import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server proxies API + WS to the gateway on :3747. Both the gateway port and
// the dev-server port can be overridden via env (CONAN_PORT / CONAN_UI_PORT) so a
// throwaway dev instance can run alongside the packaged app without clobbering it.
const GATEWAY_PORT = process.env.CONAN_PORT || "3747";
const UI_PORT = Number(process.env.CONAN_UI_PORT) || 5173;
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Don't clear the screen so Tauri's dev output stays visible when it
  // attaches to this dev server.
  clearScreen: false,
  resolve: {
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
