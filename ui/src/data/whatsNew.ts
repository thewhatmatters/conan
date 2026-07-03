/**
 * In-app "What's New" entries, keyed by app version (the `version` in
 * package.json / src-tauri/tauri.conf.json). The `WhatsNew` splash shows the
 * entry matching the *running* version the first time a returning user launches
 * after an update — see WhatsNew.tsx for the show logic.
 *
 * When you cut a release: add an entry here for the new version with 2–4 short,
 * user-facing highlights (a trimmed echo of conan-marketing's changelog,
 * src/data/releases.ts — the splash is a teaser, not the full notes). A version
 * with no entry here simply shows no splash, which is the right default for
 * patch releases not worth interrupting anyone over.
 */
export interface WhatsNewEntry {
  /** Must match the app version string exactly (no leading "v"). */
  version: string;
  /** The 2–4 things worth surfacing in a splash. Keep each to one line. */
  highlights: string[];
}

export const WHATS_NEW: Record<string, WhatsNewEntry> = {
  "1.2.0": {
    version: "1.2.0",
    highlights: [
      "Conan Setup: new terminals open a spec-first project setup — pick a method, get interviewed, start Claude with a real PRD and CLAUDE.md.",
      "One keystroke (“Start Claude instead”) skips straight to Claude; turn it off anytime in Settings ▸ Terminal.",
      "Auto context tracking is now opt-in — Conan no longer spends your context to measure it unless you ask.",
    ],
  },
  "1.1.0": {
    version: "1.1.0",
    highlights: [
      "New Files panel beside the Timeline — browse the active terminal’s working directory, following along as you cd.",
      "It flags the files Claude has edited or read this session, so you can watch the agent work the filesystem.",
    ],
  },
  "1.0.6": {
    version: "1.0.6",
    highlights: [
      "Claude Radio now finds the live stream every launch — no more “Offline” when it isn’t.",
      "This “What’s New” note, so you can see what each update brings.",
    ],
  },
};

/** The entry for a given version, or null when there's nothing to announce. */
export function whatsNewFor(version: string | null | undefined): WhatsNewEntry | null {
  if (!version) return null;
  return WHATS_NEW[version] ?? null;
}

/**
 * Decide whether the splash should show, given the running version and the two
 * persisted signals. Returns the entry to show, or null for "show nothing".
 *
 * Pure + exported on purpose: the live component path (which reads getVersion()
 * + localStorage) can't run in ANY dev build — `import.meta.env.DEV` short-
 * circuits WhatsNew.tsx to its visual-demo branch — so this is the only place
 * the real firing logic can be unit-tested. The rules:
 *   - hasRunBefore === false → fresh install: show nothing (Onboarding owns
 *     the first-run moment).
 *   - no WHATS_NEW entry for `version` → nothing to announce (e.g. a quiet
 *     patch release we chose not to interrupt anyone over).
 *   - lastSeen === version → already shown for this version; show once only.
 *   - otherwise (the version changed for a returning user — including the
 *     lastSeen === null case on the FIRST release that ships this feature) →
 *     show the entry.
 */
export function decideWhatsNew(args: {
  version: string | null | undefined;
  lastSeen: string | null;
  hasRunBefore: boolean;
}): WhatsNewEntry | null {
  const entry = whatsNewFor(args.version);
  if (!entry || !args.hasRunBefore) return null;
  if (args.lastSeen === args.version) return null;
  return entry;
}
