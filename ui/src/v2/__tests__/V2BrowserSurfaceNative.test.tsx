import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pretend we're inside the Tauri app. Both the surface and useNativeBrowser
// read this, so one mock covers the whole native path.
vi.mock("../../lib/gateway.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gateway.ts")>();
  return { ...actual, isTauri: () => true, apiBase: () => "" };
});

const { V2BrowserSurface } = await import("../components/V2SurfaceBodies.tsx");

/**
 * Randy hit this immediately: espn.com showed "This site refuses to be
 * embedded" *inside a native webview perfectly capable of displaying it*. The
 * frameability probe is an IFRAME question — asking whether localhost:5173 may
 * embed the page — and it was still gating a top-level view that no
 * `frame-ancestors` header applies to.
 */
const REFUSES_FRAMING = {
  reachable: true,
  frameable: false,
  reason: "CSP frame-ancestors does not allow http://localhost:5173",
  status: 200,
};

function stub(probe: unknown) {
  return vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes("/api/browser/probe")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(probe) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: "ESPN" }) } as Response);
  });
}

function navigateTo(value: string) {
  const input = screen.getByLabelText("URL");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("V2BrowserSurface under a native webview", () => {
  beforeEach(() => vi.stubGlobal("fetch", stub(REFUSES_FRAMING)));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads a site that refuses framing instead of showing the refusal", async () => {
    render(<V2BrowserSurface token="t" active />);
    navigateTo("https://www.espn.com");

    await waitFor(() =>
      expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/refuses to be embedded/)).toBeNull();
    // And no iframe: the native view replaces it entirely under Tauri.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("still reports a genuinely unreachable host", async () => {
    vi.stubGlobal(
      "fetch",
      stub({ reachable: false, frameable: false, reason: "connection refused", status: null }),
    );
    render(<V2BrowserSurface token="t" active />);
    navigateTo("http://localhost:9999");

    expect(await screen.findByText(/Couldn't reach that URL/)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeNull();
  });

  it("never renders the iframe's stale-URL apology — the native view knows the URL", async () => {
    render(<V2BrowserSurface token="t" active />);
    navigateTo("https://www.espn.com");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/followed a link inside this page/)).toBeNull();
  });

  it("does not time out into 'unreachable' with no iframe to fire load", async () => {
    vi.useFakeTimers();
    try {
      render(<V2BrowserSurface token="t" active />);
      navigateTo("https://www.espn.com");
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeInTheDocument(),
      );
      // Well past the iframe load-timeout, which would otherwise declare every
      // native page unreachable eight seconds after it opened.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(screen.queryByText(/Couldn't reach that URL/)).toBeNull();
      expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
