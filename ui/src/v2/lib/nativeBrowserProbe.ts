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

    // 1. Load a site that NO iframe can display. github.com sends
    //    frame-ancestors 'none' — if this renders, the view is genuinely not
    //    an iframe, which is the whole premise.
    const opened = await call<{ url: string | null; open: boolean }>("browser_open", {
      url: "https://github.com",
      x: 400,
      y: 120,
      width: 900,
      height: 600,
    });
    await report("open-github", opened);

    await wait(4000);
    const afterLoad = await call<{ url: string | null }>("browser_state");
    await report("url-after-load", afterLoad);

    // 2. A real navigation, driven from inside the page — the case the iframe
    //    could detect but never identify.
    await call("browser_eval", { script: `location.href = "https://github.com/features";` });
    await wait(4000);
    await report("url-after-link-navigation", await call("browser_state"));

    // 3. THE one an iframe cannot see at all: a client-side route change.
    //    If url() reflects this, the invisible-SPA problem is solved.
    await call("browser_eval", {
      script: `history.pushState({}, "", "/spa-route-probe");`,
    });
    await wait(1500);
    await report("url-after-pushstate", await call("browser_state"));

    // 4. Geometry + visibility — the manual work an OS view demands.
    await call("browser_set_bounds", { x: 200, y: 200, width: 600, height: 400 });
    await report("set-bounds", "ok");
    await call("browser_set_visible", { visible: false });
    await report("hide", "ok");
    await wait(500);
    await call("browser_set_visible", { visible: true });
    await report("show", "ok");

    await call("browser_close");
    await report("close", await call("browser_state"));
    await report("DONE", "probe finished");
  } catch (error) {
    await report("FAILED", String(error));
  }
}
