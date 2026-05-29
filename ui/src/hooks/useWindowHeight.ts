import { useEffect, useState } from "react";

/** Initial height that's safe in SSR / non-browser contexts. Practical
 *  default for a real Conan launch is well above the short-window floor so
 *  the first render doesn't flicker into a clamped bottom-dock layout. */
const SSR_DEFAULT = 900;

/**
 * Live window inner height (US-026). Sibling to {@link useWindowWidth} — same
 * animationFrame-throttled, passive-listener pattern so a fast drag-resize
 * doesn't fire React renders at 100+ Hz. The bottom-dock layout consumes this
 * to enforce per-region minimum heights and to clamp the HUD on a short window
 * instead of letting it collapse into an unusable sliver.
 */
export function useWindowHeight(): number {
  const [h, setH] = useState<number>(() =>
    typeof window === "undefined" ? SSR_DEFAULT : window.innerHeight,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setH(window.innerHeight));
    };
    window.addEventListener("resize", onResize, { passive: true });
    // Catch any size change that landed between mount and effect run.
    setH(window.innerHeight);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return h;
}
