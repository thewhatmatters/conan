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

  /** Measure the anchor in window coordinates and push it to the native view. */
  const syncBounds = useCallback(async () => {
    const invoke = invokeRef.current;
    const node = anchor.current;
    if (!invoke || !node) return;
    const rect = node.getBoundingClientRect();
    // A zero-area rect means the pane is collapsed or display:none — treat it
    // as hidden rather than pushing a degenerate size the OS may reject.
    if (rect.width < 1 || rect.height < 1) {
      await invoke("browser_set_visible", { visible: false }).catch(() => {});
      return;
    }
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

  // Track layout. ResizeObserver catches pane resize and splitter drags;
  // window resize and scroll move the rect without resizing the element.
  useEffect(() => {
    if (!state.supported) return;
    const node = anchor.current;
    if (!node) return;
    void syncBounds();
    const observer = new ResizeObserver(() => void syncBounds());
    observer.observe(node);
    const onWindow = () => void syncBounds();
    window.addEventListener("resize", onWindow);
    window.addEventListener("scroll", onWindow, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindow);
      window.removeEventListener("scroll", onWindow, true);
    };
  }, [anchor, syncBounds, state.supported]);

  // Visibility is explicit — CSS cannot hide an OS view.
  useEffect(() => {
    const invoke = invokeRef.current;
    if (!state.supported || !invoke) return;
    void invoke("browser_set_visible", { visible: visible && Boolean(url) }).catch(() => {});
    if (visible) void syncBounds();
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
