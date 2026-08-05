/**
 * Self-verification for the native browser view (WHA-38 spike).
 *
 * The app is a native window: no Playwright, and on this machine no assistive
 * access or screen capture either. So the app reports on itself — it drives the
 * real Tauri commands and posts each result to a listener, which is stronger
 * evidence than a screenshot anyway because it exercises the exact call path
 * the surface uses.
 *
 * Build-time gated on VITE_NATIVE_BROWSER_PROBE, so it cannot reach a shipped
 * bundle: Vite prunes the whole module when the flag is unset.
 */

const REPORT_BASE = "http://127.0.0.1:8310";

async function report(step: string, detail: unknown): Promise<void> {
  const payload = encodeURIComponent(
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
  // GET so a bare http.server logs it; failures are irrelevant to the probe.
  await fetch(`${REPORT_BASE}/probe?step=${encodeURIComponent(step)}&detail=${payload}`).catch(
    () => {},
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runNativeBrowserProbe(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const call = invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

    // 0. Geometry first — the mis-positioning needs numbers, not theories.
    //    getBoundingClientRect() is CSS px in the webview viewport; add_child
    //    takes LOGICAL px relative to the window. If the main webview does not
    //    fill the window content area 1:1, every rect we push is offset.
    const metrics = await call<{
      scale_factor: number;
      inner_width: number;
      inner_height: number;
    }>("browser_window_metrics");
    await report("window-metrics", metrics);
    await report("viewport", {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      // The delta that matters: logical inner size vs CSS viewport.
      logicalInnerW: metrics.inner_width / metrics.scale_factor,
      logicalInnerH: metrics.inner_height / metrics.scale_factor,
    });

    // 1. Drive the REAL surface, not the commands underneath it. Driving the
    //    commands directly is exactly what let two gatekeeper bugs through:
    //    it proved the view worked and never asked whether the UI would call it.
    const clickByText = (text: string): boolean => {
      const el = [...document.querySelectorAll("button,[role=menuitem]")].find((n) =>
        (n.textContent ?? "").trim().startsWith(text),
      );
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    };

    await report("open-surface-menu", clickByText("Surface"));
    await wait(600);
    await report("open-browser-surface", clickByText("Browser"));
    await wait(900);

    const input = document.querySelector<HTMLInputElement>('[data-surface="browser"] input');
    if (!input) {
      await report("FAILED", "no URL input — could not reach the Browser surface");
      return;
    }
    // React owns this input, so set through the native setter it patched over.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "https://example.com");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(4000);

    const anchorRect = (label: string) => {
      const el = document.querySelector('[data-slot="browser-native-anchor"]');
      const r = el?.getBoundingClientRect();
      return report(label, r ? {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
      } : "NO ANCHOR");
    };
    await anchorRect("anchor-rect-fullwidth");
    await report("url-through-real-ui", await call("browser_state"));

    // 2. DOCK IT. Randy's report: docking left the page sprawled across the
    //    chat at its pre-dock size, because nothing was tracking the rect after
    //    open. The rect must shrink here, and the reconcile loop must push it.
    const dockMenu = [...document.querySelectorAll("button")].find((n) =>
      (n.getAttribute("aria-label") ?? "").toLowerCase().includes("dock") ||
      (n.textContent ?? "").trim().startsWith("Surface"),
    );
    (dockMenu as HTMLElement | undefined)?.click();
    await wait(600);
    const dockItem = [...document.querySelectorAll("[role=menuitem],button")].find((n) =>
      /dock.*(right|chat)/i.test(n.textContent ?? ""),
    );
    await report("found-dock-control", Boolean(dockItem) ? (dockItem!.textContent ?? "").trim() : "none");
    (dockItem as HTMLElement | undefined)?.click();
    await wait(1500);
    await anchorRect("anchor-rect-docked");
    await report("DONE", "probe finished");
  } catch (error) {
    await report("FAILED", String(error));
  }
}
