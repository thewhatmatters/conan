// WHA-129 (fleet phase 1a): what isolation a spawn actually runs under.
//
// Containment is NOT a property of a provider — it is a property of
// (provider, permission_mode), resolved at spawn. The same binding can be
// os-sandboxed or completely uncontained depending on the mode it launches
// with, which is why the freeze doc keys floors on the resolved pair and why
// this module never answers from the provider id alone.
//
// Every branch below delegates to the driver's OWN mode-flooring function
// (`claudeModeFor` / `sandboxFor` / `grokModeFor`) rather than re-deriving the
// mapping. That is deliberate: those functions decide the flag actually passed
// to the CLI, so routing through them means the recorded class cannot drift
// from what the process was really launched with.
//
// See docs/conan-fleet-phase0-freeze.md §2.
import { claudeModeFor } from "../agent/claude.js";
import { sandboxFor } from "../agent/codex.js";
import { grokModeFor } from "../agent/grok.js";

/** The four observed containment classes. Deliberately NOT totally ordered —
 *  a cancelled grok turn does less than a codex read-only sandbox, which can
 *  still read the whole disk. A role floor is an explicit allowed-set, never a
 *  `>=` comparison (freeze doc §2). */
export const CONTAINMENT_CLASSES = [
  /** No approval channel and permission flags rejected; every tool runs. */
  "none",
  /** Approvals route to a human via the control channel; tools the user's own
   *  settings.json already allows are settled CLI-side and never prompt. */
  "prompt-gated",
  /** No approval channel exists; anything needing approval cancels the turn.
   *  Tools inside the allowlist still run. */
  "fail-closed-cancel",
  /** Kernel-enforced, fixed at spawn. */
  "os-sandbox",
] as const;

export type ContainmentClass = (typeof CONTAINMENT_CLASSES)[number];

/**
 * Resolve the containment class a spawn will actually run under.
 *
 * Unknown providers resolve to `none`. That is the worst case, not a guess:
 * an unclassified binding must never satisfy a floor by default.
 */
export function resolveContainment(
  providerId: string,
  permissionMode: string | undefined,
): ContainmentClass {
  switch (providerId) {
    case "claude":
      // `--permission-prompt-tool stdio` routes approvals to Conan's control
      // channel (claude.ts). bypassPermissions is the one mode where nothing
      // is asked — the CLI is launched with skip-permissions unconditionally
      // so that mode can be reached mid-session, so this must key on the mode.
      return claudeModeFor(permissionMode) === "bypassPermissions"
        ? "none"
        : "prompt-gated";
    case "codex":
      // The only provider with a real OS sandbox, fixed at spawn. Its own
      // `danger-full-access` setting is exactly the absence of one.
      return sandboxFor(permissionMode) === "danger-full-access"
        ? "none"
        : "os-sandbox";
    case "grok":
      // Grok has NO headless approval channel: in `default` a tool needing
      // approval ends the turn `Cancelled` (grok.ts). `grokModeFor` floors
      // every unknown mode to `default`, so unknown input lands here safely.
      //
      // Every other grok mode is classified `none` CONSERVATIVELY. We have
      // verified that default cancels; we have NOT verified which tools still
      // cancel under acceptEdits/auto/dontAsk, so they are recorded at the
      // worst case rather than an assumed middle. Narrow this only with
      // evidence from a real run, never by reading the help text.
      return ["default", "plan"].includes(grokModeFor(permissionMode))
        ? "fail-closed-cancel"
        : "none";
    case "kimi":
      // Headless `-p` REJECTS every permission flag and runs every tool
      // unprompted; the driver reports `danger-full-access` on every session
      // (kimi.ts). The mode argument is informational, so it is ignored here
      // on purpose — there is no mode that makes kimi contained.
      return "none";
    default:
      return "none";
  }
}
