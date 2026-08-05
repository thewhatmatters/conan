import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pretend we're inside the Tauri app. Both the surface and useNativeBrowser
// read this, so one mock covers the whole native path.
vi.mock("../../lib/gateway.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gateway.ts")>();
  return { ...actual, isTauri: () => true, apiBase: () => "" };
});

// Stand in for the native view so the SURFACE's reporting can be tested
// independently of Tauri. `nativeUrl` is what the real view would return from
// browser_state after the user clicks a link or an SPA changes route.
let nativeUrl: string | null = null;
/** Lets the test push a new live URL and actually re-render, the way a real
 *  navigation inside the webview would. */
let pushNativeUrl: (url: string | null) => void = () => {};
vi.mock("../lib/useNativeBrowser.ts", async () => {
  const { useState, useEffect } = await import("react");
  return {
    useNativeBrowser: () => {
      const [url, setUrl] = useState<string | null>(nativeUrl);
      useEffect(() => {
        pushNativeUrl = (next) => {
          nativeUrl = next;
          setUrl(next);
        };
      }, []);
      return { supported: true, url, open: url !== null, error: null, evalScript: async () => {} };
    },
  };
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
  beforeEach(() => {
    nativeUrl = null;
    vi.stubGlobal("fetch", stub(REFUSES_FRAMING));
  });
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

  it("reports the native view's LIVE url to the agent, not the one in the bar", async () => {
    // The whole point of WHA-38 for WHA-109: the user opens one page, clicks
    // through to another, and the agent is told where they actually are. The
    // iframe could never do this — it is why `read_browser` had to refuse.
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active onStateChange={onStateChange} />);
    navigateTo("https://www.espn.com");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeInTheDocument(),
    );

    // The user clicks into an article; the native view knows, the URL bar doesn't.
    act(() => pushNativeUrl("https://www.espn.com/nfl/story/_/id/12345"));

    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          url: "https://www.espn.com/nfl/story/_/id/12345",
          // Never stale under a native view, so the agent is never told to stop.
          navigatedAway: false,
        }),
      ),
    );
  });

  it("never marks the surface stale under a native view", async () => {
    nativeUrl = "https://www.espn.com/";
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active onStateChange={onStateChange} />);
    navigateTo("https://www.espn.com");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="browser-native-anchor"]')).toBeInTheDocument(),
    );
    // The iframe's "I've lost track of you" apology must never appear here —
    // there is nothing to lose track of.
    expect(screen.queryByText(/followed a link inside this page/)).toBeNull();
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ navigatedAway: false }),
      ),
    );
  });
});
