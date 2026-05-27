import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server proxies API + WS to the gateway on :3747.
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
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3747",
      "/ws": { target: "ws://127.0.0.1:3747", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
