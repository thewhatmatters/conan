/**
 * Drives the native browser view for the Browser surface (WHA-38).
 *
 * Electron's `<webview>` is a DOM element, so it lays out with CSS and needs no
 * help. Tauri's child webview is an OS-level view positioned in **window
 * coordinates**: it knows nothing about `display: none`, `overflow: clip`,
 * border radius, or z-index. So the renderer has to do by hand what CSS would
 * otherwise do for free — this hook is that hand.
 *
 * Three jobs, and every one of them is a place the illusion breaks if missed:
 *   1. keep the view's rect glued to a placeholder element's rect,
 *   2. hide the view whenever the placeholder is not actually visible
 *      (hidden surface, chat tab, collapsed pane) — CSS hiding the placeholder
 *      does nothing to the native view, which would otherwise float over the
 *      chat,
 *   3. report the view's real current URL back, which is the entire point:
 *      it survives link clicks and SPA routing that an iframe hides from us.
 *
 * Degrades to `supported: false` outside Tauri so plain-browser dev keeps
 * working on the iframe path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../../lib/gateway.ts";

export interface NativeBrowserState {
  /** A native view is available in this runtime (Tauri desktop). */
  supported: boolean;
  /** The view's live URL — accurate after link clicks AND SPA routing. */
  url: string | null;
  open: boolean;
  error: string | null;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * `add_child` positions relative to the WINDOW's content area;
 * `getBoundingClientRect()` is relative to the webview VIEWPORT. On macOS the
 * webview sits below the titlebar, so the two origins differ — measured here as
 * exactly 32px vertically, 0 horizontally.
 *
 * Derived at runtime rather than hard-coded: the difference between the
 * window's logical inner size and the CSS viewport IS the chrome offset,
 * whatever the platform or titlebar style. A constant would be wrong the moment
 * the window style changed, and wrong silently.
 */
interface WindowMetrics {
  scale_factor: number;
  inner_width: number;
  inner_height: number;
}

function chromeOffset(metrics: WindowMetrics | null): { x: number; y: number } {
  if (!metrics || !metrics.scale_factor) return { x: 0, y: 0 };
  const logicalW = metrics.inner_width / metrics.scale_factor;
  const logicalH = metrics.inner_height / metrics.scale_factor;
  return {
    x: Math.max(0, logicalW - window.innerWidth),
    y: Math.max(0, logicalH - window.innerHeight),
  };
}

/**
 * Overlays that must never be painted *under* the browser view.
 *
 * QA confirmed this is product-breaking, not cosmetic: ⌘K over a live browser
 * opens and takes focus while being invisible in pixels — the user is typing
 * into something they cannot see. Full-pane it vanishes entirely; docked, it is
 * sliced in half down the pane edge.
 *
 * A native view composites above the entire webview and no z-index reaches it,
 * so the only lever is to hide the view while an overlay would cover it.
 *
 * Astryx's Dialog renders a real `<dialog open aria-modal="true">`, which the
 * first two selectors catch; the command palette is not a native dialog, hence
 * the explicit slot. Any NEW overlay must be a native dialog, carry
 * `aria-modal`, or be added here — otherwise it will silently render beneath a
 * browser and look like it never opened.
 */
const OVERLAY_SELECTOR = [
  "dialog[open]",
  '[aria-modal="true"]',
  '[data-slot="command-palette"]',
].join(",");

/**
 * Whether any overlay actually covers the view's rect.
 *
 * Intersection rather than mere presence, because hiding on *any* open overlay
 * would blink the page away for menus that never touch it — the Surface and
 * Actions dropdowns sit above the pane and are fine. Hide exactly when the
 * overlay would be occluded, and no more.
 */
function overlayCovers(rect: DOMRect): boolean {
  // Edges derived from x/y/width/height rather than read off `right`/`bottom`,
  // so this holds for any rect-like value and cannot silently compare against a
  // zero edge.
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const oRight = r.x + r.width;
    const oBottom = r.y + r.height;
    if (r.x < right && oRight > left && r.y < bottom && oBottom > top) return true;
  }
  return false;
}

/** Tauri's invoke, loaded lazily so the browser build never imports it. */
async function getInvoke(): Promise<Invoke | null> {
  if (!isTauri()) return null;
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke as Invoke;
}

/** How often to re-read the view's URL. The webview owns navigation, so this
 *  is the renderer's only way to notice a link click or a route change. A
 *  push-based `did-navigate` equivalent would be better; Tauri exposes no such
 *  event, so polling is the honest mechanism rather than a shortcut. */
const URL_POLL_MS = 700;

export function useNativeBrowser(input: {
  /** The element whose rect the native view should occupy. */
  anchor: React.RefObject<HTMLElement | null>;
  /** URL to load; null closes the view. */
  url: string | null;
  /** Whether the pane is genuinely on screen right now. */
  visible: boolean;
}): NativeBrowserState & { evalScript: (script: string) => Promise<void> } {
  const { anchor, url, visible } = input;
  const [state, setState] = useState<NativeBrowserState>({
    supported: isTauri(),
    url: null,
    open: false,
    error: null,
  });
  const invokeRef = useRef<Invoke | null>(null);
  const offsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // The caller's intent, readable from the reconcile loop without making the
  // loop depend on it (a changing dep would restart the loop every toggle).
  const wantVisibleRef = useRef(false);
  /** What the OS view's visibility currently IS, so we only call on a change. */
  const shownRef = useRef(false);
  // The last rect we pushed, so a resize storm doesn't spam IPC with no-ops.
  const lastRect = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    void getInvoke().then(async (invoke) => {
      if (cancelled || !invoke) return;
      invokeRef.current = invoke;
      // Measure the chrome offset before the first bounds push, so the view is
      // never placed at the wrong origin even momentarily.
      const metrics = await invoke<WindowMetrics>("browser_window_metrics").catch(() => null);
      if (!cancelled) {
        offsetRef.current = chromeOffset(metrics);
        setState((s) => ({ ...s, supported: true }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Reconcile the native view against the DOM: should it be visible at all, and
   * where. Visibility and geometry are decided together because they share the
   * same inputs — an absent anchor, a collapsed pane and a covering overlay are
   * all "not right now", and splitting them let one of them get forgotten.
   */
  const syncBounds = useCallback(async () => {
    const invoke = invokeRef.current;
    if (!invoke) return;
    const node = anchor.current;
    const rect = node?.getBoundingClientRect();
    // A zero-area rect means the pane is collapsed or display:none.
    const hasRect = Boolean(rect && rect.width >= 1 && rect.height >= 1);
    const shouldShow =
      hasRect && wantVisibleRef.current && !overlayCovers(rect as DOMRect);

    if (shouldShow !== shownRef.current) {
      shownRef.current = shouldShow;
      await invoke("browser_set_visible", { visible: shouldShow }).catch(() => {});
    }
    if (!shouldShow || !rect) return;

    const offset = offsetRef.current;
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (key === lastRect.current) return;
    lastRect.current = key;
    await invoke("browser_set_bounds", {
      x: rect.x + offset.x,
      y: rect.y + offset.y,
      width: rect.width,
      height: rect.height,
    }).catch(() => {});
  }, [anchor]);

  // Open / navigate.
  useEffect(() => {
    const invoke = invokeRef.current;
    if (!state.supported) return;
    if (!invoke) return;
    if (!url) {
      void invoke("browser_close").catch(() => {});
      setState((s) => ({ ...s, open: false, url: null }));
      return;
    }
    const node = anchor.current;
    const rect = node?.getBoundingClientRect();
    const offset = offsetRef.current;
    void invoke<NativeBrowserState>("browser_open", {
      url,
      x: (rect?.x ?? 0) + offset.x,
      y: (rect?.y ?? 0) + offset.y,
      width: Math.max(rect?.width ?? 640, 1),
      height: Math.max(rect?.height ?? 480, 1),
    })
      .then((next) => setState((s) => ({ ...s, ...next, error: null })))
      .catch((error: unknown) =>
        setState((s) => ({ ...s, error: String(error), open: false })),
      );
  }, [url, anchor, state.supported]);

  // Track layout by reconciling every frame while the view is open.
  //
  // This was a ResizeObserver attached on mount, and it never attached at all:
  // at mount the surface is empty, so the anchor is not rendered, `anchor.current`
  // is null and the effect bailed — and its deps (a stable ref, a stable
  // callback, an unchanged boolean) meant it never ran again. The only bounds
  // the view ever got were the ones passed at open, which is why docking left
  // the page sprawled across the chat at its pre-dock size.
  //
  // A per-frame reconcile is the honest mechanism for pinning an OS view to a
  // DOM rect, and not a workaround for that bug: an observer catches resizes of
  // one node, but the rect also moves when the pane is REPOSITIONED without
  // resizing, when React swaps the node, and continuously during a splitter
  // drag. Reading `anchor.current` fresh each frame covers all of it, and the
  // cost is one getBoundingClientRect while a browser is on screen.
  useEffect(() => {
    if (!state.supported || !url) return;
    let frame = 0;
    const tick = () => {
      void syncBounds();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [syncBounds, state.supported, url]);

  // Visibility is explicit — CSS cannot hide an OS view. This only records the
  // caller's intent; the reconcile loop applies it alongside the overlay and
  // rect checks, so exactly one place decides what is on screen.
  useEffect(() => {
    wantVisibleRef.current = visible && Boolean(url);
    if (state.supported) void syncBounds();
  }, [visible, url, syncBounds, state.supported]);

  // Poll the real URL so link clicks and SPA routing stay visible to us.
  useEffect(() => {
    const invoke = invokeRef.current;
    if (!state.supported || !invoke || !url) return;
    const timer = setInterval(() => {
      void invoke<NativeBrowserState>("browser_state")
        .then((next) => {
          setState((s) => (s.url === next.url && s.open === next.open ? s : { ...s, ...next }));
        })
        .catch(() => {});
    }, URL_POLL_MS);
    return () => clearInterval(timer);
  }, [url, state.supported]);

  // Close on unmount — an orphaned OS view would float over the whole app.
  useEffect(() => {
    return () => {
      void invokeRef.current?.("browser_close").catch(() => {});
    };
  }, []);

  const evalScript = useCallback(async (script: string) => {
    await invokeRef.current?.("browser_eval", { script });
  }, []);

  return { ...state, evalScript };
}
