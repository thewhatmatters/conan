import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server proxies API + WS to the gateway on :3747.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3747",
      "/ws": { target: "ws://127.0.0.1:3747", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
