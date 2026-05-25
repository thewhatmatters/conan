// node-pty's macOS/Linux prebuilds sometimes extract without the execute bit on
// `spawn-helper`, which makes pty.spawn fail with "posix_spawnp failed".
// Restore +x after every install. No-op on Windows (no spawn-helper) and when
// node-pty isn't present.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const base = path.resolve("node_modules/node-pty/prebuilds");
if (existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = path.join(base, dir, "spawn-helper");
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
      } catch {
        /* best-effort */
      }
    }
  }
}
