import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import conanIcon from "../assets/conan-icon.png";
import { isTauri } from "../lib/gateway.ts";
import {
  WHATS_NEW,
  whatsNewFor,
  decideWhatsNew,
  type WhatsNewEntry,
} from "../data/whatsNew.ts";

/**
 * "What's New" splash — a small, once-per-version card shown the first time a
 * returning user launches Conan after an update, summarizing what that release
 * added. The full notes live on the website changelog; this is the teaser.
 *
 * Show logic:
 *   - Read the running app version (Tauri `getVersion()`), the last version we
 *     showed this splash for (`localStorage`), and whether the user has run
 *     Conan before (the Onboarding ack key — see Onboarding.tsx).
 *   - Show only when: there's a `WHATS_NEW` entry for the running version AND
 *     the version differs from the last one we recorded AND the user has run
 *     Conan before. So:
 *       · fresh installs see the Onboarding welcome instead (no prior run),
 *       · patch releases with no entry interrupt no one,
 *       · the FIRST release carrying this feature still debuts correctly for
 *         everyone updating into it (they've run before, but never recorded a
 *         last-seen version — null differs from the new version → shown).
 *   - We record the running version as "seen" on mount regardless, so the
 *     splash fires exactly once per version and a later update diffs cleanly.
 *
 * Like UpdateBanner, the Tauri API is lazy-imported so the plain-browser dev
 * build doesn't try to resolve native bindings; in dev the splash auto-surfaces
 * for visual iteration and `window.__conanWhatsNewDemo('1.0.6')` re-opens it.
 */
const LAST_SEEN_KEY = "conan.whatsNew.lastSeenVersion";
/** Mirrors Onboarding.tsx's ACK_KEY — its presence means "has run before". */
const ONBOARDING_ACK_KEY = "conan.onboarding.acknowledged";

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode — best-effort; the splash just may re-show next launch */
  }
}

/** The running app version, via the Tauri app API. null outside Tauri (a plain
 *  browser) or if the import/call fails — the splash then simply stays hidden. */
async function loadAppVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const mod = await import("@tauri-apps/api/app");
    return await mod.getVersion();
  } catch {
    return null;
  }
}

export default function WhatsNew() {
  const [entry, setEntry] = useState<WhatsNewEntry | null>(null);

  useEffect(() => {
    // Dev (plain browser or tauri:dev): surface the newest entry immediately so
    // the splash is visually testable without an update, and expose a DevTools
    // hook to re-open it. Dead-code-eliminated from the production bundle.
    if (import.meta.env.DEV) {
      const demo = whatsNewFor("1.0.6") ?? Object.values(WHATS_NEW)[0] ?? null;
      setEntry(demo);
      (
        window as unknown as { __conanWhatsNewDemo?: (v?: string) => void }
      ).__conanWhatsNewDemo = (v?: string) =>
        setEntry(whatsNewFor(v ?? "1.0.6") ?? Object.values(WHATS_NEW)[0] ?? null);
      return;
    }

    let cancelled = false;
    void loadAppVersion().then((version) => {
      if (cancelled || !version) return;
      const e = decideWhatsNew({
        version,
        lastSeen: lsGet(LAST_SEEN_KEY),
        hasRunBefore: lsGet(ONBOARDING_ACK_KEY) === "1",
      });
      // Record the running version as seen no matter what — fires once per
      // version, and a future update diffs against this.
      lsSet(LAST_SEEN_KEY, version);
      if (e) setEntry(e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entry) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="p-7">
          <img
            src={conanIcon}
            alt="Conan"
            className="mb-4 size-12 rounded-xl"
          />
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <Sparkles className="size-3.5 text-brand" />
            What&rsquo;s new
          </p>
          <h2 className="mt-1.5 text-lg font-semibold text-foreground">
            Conan {entry.version}
          </h2>

          <ul className="mt-4 space-y-2.5">
            {entry.highlights.map((h, i) => (
              <li
                key={i}
                className="relative pl-5 text-[13px] leading-relaxed text-muted-foreground"
              >
                <span
                  aria-hidden
                  className="absolute left-0 top-[0.55em] size-1.5 rounded-full bg-brand"
                />
                {h}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => setEntry(null)}
            className="mt-6 w-full rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground transition-colors hover:bg-brand/90"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
