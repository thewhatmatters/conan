import { useEffect, useState } from "react";
import { useAppearance } from "./useAppearance.ts";

/**
 * Combined motion gate for decorative animations.
 *
 * Two inputs:
 *   - `appearance.animationsEnabled` — the user's explicit Settings ▸
 *     Appearance toggle. Default on.
 *   - `prefers-reduced-motion: reduce` — the OS-level accessibility hint.
 *     Always wins; if the OS says reduce, animations stay off regardless
 *     of the in-app toggle (we don't override accessibility).
 *
 * Returns `true` when decorative animations should play. Use everywhere
 * Conan plays a non-essential animation (License unlock burst, Timeline
 * skill-fired lightning) so they all switch together — one setting, one
 * source of truth.
 */
export function useMotion(): boolean {
  const { appearance } = useAppearance();
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    // Modern browsers expose addEventListener; old Safari only addListener.
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return appearance.animationsEnabled && !reducedMotion;
}
