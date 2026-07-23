import { useState } from "react";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import conanIcon from "../assets/conan-icon.png";
// Bottom-anchored background art. Replace this file with your own image (keep
// the path/name) — a tall-ish image reads best since it's anchored to the
// dialog's bottom and fades upward under the scrim below.
import onboardingBg from "../assets/onboarding-bg.png";

/** First-run welcome (+ recovery prompt). Conan only observes Claude Code —
 *  it can't run it — so a one-time screen sets that expectation, and the live
 *  detection status makes the "Get started" acknowledgment meaningful rather
 *  than a dumb OK.
 *
 *  Show logic (decided 2026-05-30):
 *    - First run ever (no `acknowledged` flag) → show.
 *    - Re-surface on a later launch ONLY if Claude Code is now undetected
 *      (`doctor.installed === false`) — doubles as a recovery prompt.
 *    - Never blocks: "Get started" always lets the user in (Conan is an
 *      observer; the persistent install banner keeps nudging afterward).
 *    - A this-session guard stops it from popping back after dismissal. */
const ACK_KEY = "conan.onboarding.acknowledged";
const SESSION_KEY = "conan.onboarding.dismissed";

function read(storage: Storage, key: string): boolean {
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export default function Onboarding({
  doctor,
}: {
  doctor?: { installed: boolean | null; version: string | null };
}) {
  const [dismissed, setDismissed] = useState<boolean>(() =>
    read(sessionStorage, SESSION_KEY),
  );
  const acknowledgedEver = read(localStorage, ACK_KEY);

  // Suppressed during dev (Vite dev server) so the welcome/recovery splash
  // doesn't block iteration — matches WhatsNew's own `import.meta.env.DEV`
  // gate. The bundled Tauri app (production build) still shows it normally.
  if (import.meta.env.DEV) return null;

  // First run, or Claude Code went missing after a prior acknowledgment.
  const shouldShow =
    !dismissed && (!acknowledgedEver || doctor?.installed === false);
  if (!shouldShow) return null;

  const getStarted = () => {
    try {
      localStorage.setItem(ACK_KEY, "1");
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* private mode — fall back to in-memory dismissal for this mount */
    }
    setDismissed(true);
  };

  const installed = doctor?.installed ?? null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card text-center shadow-2xl">
        {/* Background image, anchored to the bottom of the card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-cover bg-bottom bg-no-repeat"
          style={{ backgroundImage: `url(${onboardingBg})` }}
        />
        {/* Readability scrim — card color stays opaque at the top so the
            heading/body never wash out, and fades toward the bottom so the
            image shows through. Tune the /xx opacities to taste. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-card/80 via-card/92 to-card"
        />
        <div className="relative p-7">
        <img
          src={conanIcon}
          alt="Conan"
          className="mx-auto mb-4 size-12 rounded-xl"
        />
        <h2 className="text-lg font-semibold text-foreground">
          Welcome to Conan
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          Conan is a cockpit for{" "}
          <span className="font-medium text-foreground">Claude Code</span> — it
          observes your sessions (Context, Usage, Pulse, Skills) but doesn&rsquo;t
          replace the CLI. You drive Claude Code in the terminal; Conan watches
          and visualizes. It needs Claude Code installed to do anything useful.
        </p>

        {/* Live detection status — makes the acknowledgment real. */}
        <div className="mt-5">
          {installed === null && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Checking for Claude Code&hellip;
            </div>
          )}
          {installed === true && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-3.5" />
              Claude Code detected
              {doctor?.version ? ` — v${doctor.version}` : ""}
            </div>
          )}
          {installed === false && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-left text-[12px] text-amber-700 dark:text-amber-300">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="size-3.5 shrink-0" />
                Claude Code isn&rsquo;t installed
              </div>
              <div className="mt-1.5 text-amber-700/90 dark:text-amber-300/90">
                Install it, then Conan will pick it up automatically:
              </div>
              <code className="mt-1.5 block rounded bg-amber-500/15 px-2 py-1 font-mono text-[11px]">
                npm install -g @anthropic-ai/claude-code
              </code>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={getStarted}
          className="mt-6 w-full rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Get started
        </button>
        <a
          href="https://claude.com/claude-code"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block text-[11px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          What is Claude Code?
        </a>
        </div>
      </div>
    </div>
  );
}
