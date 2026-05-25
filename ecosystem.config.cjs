/**
 * PM2 process definition for the Conan gateway (US-019).
 *
 * Supervises the single always-on gateway on :3747 with autorestart on crash
 * and boot persistence via `pm2 startup` + `pm2 save`. See docs/ops.md for the
 * start/stop/status commands.
 *
 * `.cjs` (not `.js`) because package.json sets "type":"module" — PM2 loads the
 * ecosystem file with require(), which needs CommonJS.
 */
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "conan-gateway",
      // Run the TS entry directly through tsx (same as `npm start`, no watch).
      script: "src/gateway/index.ts",
      interpreter: path.join(__dirname, "node_modules", ".bin", "tsx"),
      cwd: __dirname,

      // Single gateway instance — the gateway is single-instance on :3747.
      instances: 1,
      exec_mode: "fork",

      // Restart on crash, with a small delay + a cap so a hard-failing boot
      // (e.g. EADDRINUSE) doesn't spin forever.
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      // Treat a process that dies within 10s of start as a failed boot.
      min_uptime: "10s",
      // Don't churn the disk by watching files; this is the no-watch path.
      watch: false,

      // Roll logs into .data (already gitignored) with timestamps.
      time: true,
      out_file: path.join(__dirname, ".data", "pm2-gateway.out.log"),
      error_file: path.join(__dirname, ".data", "pm2-gateway.err.log"),
      merge_logs: true,

      env: {
        NODE_ENV: "production",
        // Loopback-only by default (US-002). Override CONAN_HOST/CONAN_PORT
        // here or in the environment to change the bind.
      },
    },
  ],
};
