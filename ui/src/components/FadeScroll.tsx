import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface FadeScrollProps {
  children: ReactNode;
  /** Extra classes applied to the inner scroll container (e.g. padding). */
  className?: string;
  /** Background color the fade dissolves from. Defaults to the HUD's `card`;
   *  the Terminal passes `term-bg` and Timeline composes its own. Use any
   *  CSS-token class that resolves to a solid color (`from-card`, etc.). */
  fadeFrom?: string;
  /** Height of the fade band. Tailwind class (e.g. `h-6`, `h-8`). */
  fadeHeight?: string;
}

/**
 * Drop-in scroll container that fades the content under a subtle gradient
 * whenever there's overflow above or below the visible viewport. The fades
 * sit ON TOP of the scroller (`pointer-events-none` so they don't intercept
 * hover/scroll) and opacity-transition in/out so the indicators self-clear
 * once the user reaches an edge or the content shrinks to fit.
 *
 * Used by the HUD panels (Usage / Pulse / Skills / MCP) and the Timeline
 * split — same pattern, same scroll-state math, one component to maintain.
 * (Terminal uses xterm's own scroll API directly; same visual idea, different
 * data source.)
 */
export default function FadeScroll({
  children,
  className = "",
  fadeFrom = "from-card",
  fadeHeight = "h-6",
}: FadeScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) {
      setCanScrollUp(false);
      setCanScrollDown(false);
      return;
    }
    setCanScrollUp(el.scrollTop > 1);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  // Recompute on content-size change (a new widget row appearing, the panel
  // re-rendering after a refetch) and on container resize (HUD drag-resize,
  // theme switch, etc.). One ResizeObserver covers both — no scroll event
  // fires for either.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Also observe the first child so content growth triggers a recompute even
    // if the scroller itself doesn't resize.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [update, children]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={update}
        className={"absolute inset-0 overflow-auto " + className}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={
          `pointer-events-none absolute inset-x-0 top-0 ${fadeHeight} bg-gradient-to-b ${fadeFrom} to-transparent transition-opacity duration-200 ` +
          (canScrollUp ? "opacity-100" : "opacity-0")
        }
      />
      <div
        aria-hidden
        className={
          `pointer-events-none absolute inset-x-0 bottom-0 ${fadeHeight} bg-gradient-to-t ${fadeFrom} to-transparent transition-opacity duration-200 ` +
          (canScrollDown ? "opacity-100" : "opacity-0")
        }
      />
    </div>
  );
}
