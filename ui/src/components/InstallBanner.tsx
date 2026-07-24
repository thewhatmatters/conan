import { useState } from "react";
import { X } from "lucide-react";

/**
 * One-line banner pinned above the main surface when the gateway's doctor
 * probe reports `claude` is not installed. Dismissible per-session
 * (sessionStorage), so a fresh launch reminds the user but a casual reload
 * doesn't nag. Hidden during the initial probe (`installed: null`) to avoid
 * a flash; hidden permanently once the user dismisses or installs Claude.
 *
 * Extracted from TerminalPane (US-012) when chat became the only surface —
 * the chat threads spawn headless `claude` directly, so without an install
 * nothing works; the banner explains what's missing and how to fix it.
 */
export default function InstallBanner({
  doctor,
}: {
  doctor?: { installed: boolean | null };
}) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(BANNER_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (!doctor || doctor.installed !== false || dismissed) return null;
  const dismiss = () => {
    try {
      sessionStorage.setItem(BANNER_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
      <span className="min-w-0">
        <span className="font-medium">Claude Code isn't installed.</span>{" "}
        Conan drives it but can't install it for you. Install:{" "}
        <code className="rounded bg-amber-500/15 px-1 py-px font-mono text-[10px]">
          npm install -g @anthropic-ai/claude-code
        </code>{" "}
        or see{" "}
        <a
          href="https://claude.com/claude-code"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
        >
          docs
        </a>
        .
      </span>
      <button
        type="button"
        onClick={dismiss}
        title="Dismiss for this session"
        className="shrink-0 rounded p-0.5 text-amber-700/70 transition-colors hover:bg-amber-500/15 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-100"
      >
        <X className="size-3" strokeWidth={2.5} />
      </button>
    </div>
  );
}

const BANNER_DISMISS_KEY = "conan.doctor.banner.dismissed";
