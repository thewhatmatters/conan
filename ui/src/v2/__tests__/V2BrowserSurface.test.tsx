import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { V2BrowserSurface } from "../components/V2SurfaceBodies.tsx";

/**
 * WHA-109. Two behaviours are worth locking down here, and they are the two
 * v2 originally shipped without: the surface must tell the user WHY a page did
 * not render (a cross-origin iframe cannot say so itself), and it must report
 * what it is showing so the agent's auto-context line can name the page.
 */

/** Route the two gateway calls the surface makes; unrouted URLs reject. */
function stubGateway(routes: {
  probe?: unknown;
  probeStatus?: number;
  read?: unknown;
  readStatus?: number;
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/browser/probe")) {
      if (routes.probe === undefined) return Promise.reject(new Error("probe unavailable"));
      return Promise.resolve({
        ok: (routes.probeStatus ?? 200) < 400,
        json: () => Promise.resolve(routes.probe),
      } as Response);
    }
    if (url.includes("/api/browser/read")) {
      if (routes.read === undefined) return Promise.reject(new Error("read unavailable"));
      return Promise.resolve({
        ok: (routes.readStatus ?? 200) < 400,
        json: () => Promise.resolve(routes.read),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

/**
 * Navigate via the Enter key rather than the Open button. Astryx's `Button`
 * drops a second synthetic click when the surrounding input has re-rendered in
 * the same tick (verified with a standalone probe against `@astryxdesign/core`
 * — the second `clickAction` never fires at all, stale or otherwise). The
 * keyboard path has no such quirk, and it is a real user path. One test below
 * still drives the button, which works for a single click.
 */
function navigateTo(value: string) {
  const input = screen.getByLabelText("URL");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

const FRAMEABLE = { reachable: true, frameable: true, reason: null, status: 200 };

describe("V2BrowserSurface", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubGateway({ probe: FRAMEABLE, read: { title: "Local app" } }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts empty and reports no page", () => {
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active onStateChange={onStateChange} />);

    expect(screen.getByText(/Enter a URL/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(onStateChange).toHaveBeenCalledWith({
      url: null,
      active: true,
      title: null,
      problem: null,
    });
  });

  it("frames a permitted page and reports its gateway-read title", async () => {
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active onStateChange={onStateChange} />);
    // The one case driven through the Open button, so that path stays covered.
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "localhost:5173" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const frame = await screen.findByTitle("Local app");
    expect(frame).toHaveAttribute("src", "http://localhost:5173/");
    // The title cannot come from the frame — cross-origin. Its presence in the
    // report is the proof the gateway read supplied it.
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith({
        url: "http://localhost:5173/",
        active: true,
        title: "Local app",
        problem: null,
      }),
    );
  });

  it("explains a framing refusal instead of showing a blank frame", async () => {
    vi.stubGlobal(
      "fetch",
      stubGateway({
        probe: {
          reachable: true,
          frameable: false,
          reason: "X-Frame-Options: DENY forbids embedding",
          status: 200,
        },
      }),
    );
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active onStateChange={onStateChange} />);
    navigateTo("https://github.com");

    expect(await screen.findByText(/refuses to be embedded/)).toBeInTheDocument();
    expect(screen.getByText(/X-Frame-Options: DENY/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open in system browser/ })).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    // The agent must be told the page failed, not handed a URL it cannot see.
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith({
        url: "https://github.com/",
        active: true,
        title: null,
        problem: "X-Frame-Options: DENY forbids embedding",
      }),
    );
  });

  it("reports an unreachable host with its reason", async () => {
    vi.stubGlobal(
      "fetch",
      stubGateway({
        probe: { reachable: false, frameable: false, reason: "connection refused", status: null },
      }),
    );
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active onStateChange={onStateChange} />);
    navigateTo("localhost:9999");

    expect(await screen.findByText(/Couldn't reach that URL/)).toBeInTheDocument();
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith({
        url: "http://localhost:9999/",
        active: true,
        title: null,
        problem: "connection refused",
      }),
    );
  });

  it("still frames the page when the probe route is missing (stale gateway)", async () => {
    // A rejected probe must degrade to the load-timeout heuristic, never block
    // the surface outright — an older gateway has no /api/browser/probe.
    vi.stubGlobal("fetch", stubGateway({ read: { title: null } }));
    render(<V2BrowserSurface token="t" active />);
    navigateTo("localhost:5173");

    expect(await screen.findByTitle("Browser surface")).toHaveAttribute(
      "src",
      "http://localhost:5173/",
    );
  });

  it("reports active=false so a hidden surface adds no auto-context", async () => {
    const onStateChange = vi.fn();
    render(<V2BrowserSurface token="t" active={false} onStateChange={onStateChange} />);
    navigateTo("localhost:5173");

    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "http://localhost:5173/", active: false }),
      ),
    );
  });

  it("keeps Refresh disabled until there is a page to refresh", async () => {
    render(<V2BrowserSurface token="t" active />);
    const refresh = screen.getByRole("button", { name: /Refresh/ });
    expect(refresh).toBeDisabled();

    navigateTo("localhost:5173");
    await screen.findByTitle("Local app");
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeEnabled();
  });

  it("ignores a stale probe that resolves after a newer navigation", async () => {
    // Without the nav-sequence guard, a slow first probe lands last and
    // overwrites the page the user actually asked for.
    let resolveFirst: (value: unknown) => void = () => {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/browser/probe")) {
        if (url.includes("slow")) {
          return new Promise((resolve) => {
            resolveFirst = () => resolve({ ok: true, json: () => Promise.resolve(FRAMEABLE) } as Response);
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(FRAMEABLE) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ title: null }) } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<V2BrowserSurface token="t" active />);
    navigateTo("http://slow.test/");
    navigateTo("http://fast.test/");
    await screen.findByTitle("Browser surface");
    resolveFirst(null);

    await waitFor(() =>
      expect(screen.getByTitle("Browser surface")).toHaveAttribute("src", "http://fast.test/"),
    );
  });
});
