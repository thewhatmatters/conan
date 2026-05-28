import { useEffect, useState } from "react";

/** Initial width that's safe in SSR / non-browser contexts. Practical
 *  default for a real Conan launch is well above any of our breakpoints
 *  so the first render doesn't flicker into a narrow-mode layout. */
const SSR_DEFAULT = 1400;

/**
 * Live window inner width. Throttled to one update per animationFrame so a
 * fast drag-resize doesn't fire React renders at 100+ Hz; the resize handler
 * itself stays passive. Returns the natural pixel width — consumers compare
 * it against their own breakpoint constants.
 */
export function useWindowWidth(): number {
  const [w, setW] = useState<number>(() =>
    typeof window === "undefined" ? SSR_DEFAULT : window.innerWidth,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setW(window.innerWidth));
    };
    window.addEventListener("resize", onResize, { passive: true });
    // Catch any size change that landed between mount and effect run.
    setW(window.innerWidth);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return w;
}
