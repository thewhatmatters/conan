#!/usr/bin/env tsx
// US-002: CLI to install/uninstall Conan's GLOBAL Claude Code hooks into the
// user-level ~/.claude/settings.json, so every `claude` run on this machine —
// in any repo — self-reports to the dashboard.
//
//   tsx scripts/install-global-hooks.mjs          # install (idempotent)
//   tsx scripts/install-global-hooks.mjs --remove # uninstall
//
// Non-destructive: merges into existing settings, preserves unknown keys, and
// backs up the file (.conan-bak) before any change. Re-running is a no-op.
import {
  installGlobalHooks,
  uninstallGlobalHooks,
} from "../src/hooks/install.ts";

const remove = process.argv.includes("--remove") || process.argv.includes("--uninstall");
const result = remove ? uninstallGlobalHooks() : installGlobalHooks();

if (remove) {
  console.log(
    result.changed
      ? `Removed Conan global hooks from ${result.path}`
      : `No Conan global hooks found in ${result.path} (nothing to remove)`,
  );
} else if (result.changed) {
  console.log(`Installed Conan global hooks into ${result.path}`);
  console.log(`  command: ${result.command}`);
  console.log(`  events:  ${result.added.join(", ")}`);
  console.log(
    "\nEvery `claude` run on this machine now forwards lifecycle events to the\n" +
      "Conan gateway (fire-and-forget; safe when the gateway is down).",
  );
} else {
  console.log(`Conan global hooks already present in ${result.path} — no change.`);
}
