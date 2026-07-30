/**
 * The v2 feature flag (T0 · docs/v2-astryx-redesign.md §4.1).
 *
 * This is the most load-bearing test in the v2 suite: the whole redesign is
 * allowed to be half-built precisely BECAUSE v1 is untouched with the flag off.
 * Two properties are pinned here — the flag's precedence rules, and the routing
 * decision `App.tsx` makes from them.
 *
 * WHY THE FLAG IS RE-READ VIA `vi.resetModules()`
 * -----------------------------------------------
 * `App.tsx` evaluates `isV2Enabled()` ONCE at module scope (v1 and v2 load
 * different global stylesheets, so the choice cannot change mid-session). A
 * test that just flipped `localStorage` and re-rendered would therefore assert
 * nothing. Each routing case resets the module registry and re-imports App, so
 * the module-scope read happens again under the flag being tested.
 *
 * WHY `AppV2` IS STUBBED HERE
 * ---------------------------
 * Only its identity is under test — "did the router pick v2?" — and mounting
 * the real one would pull Astryx's app-GLOBAL stylesheets into this document
 * for the v1 case to then be checked against. `importOriginal` keeps the REAL
 * `isV2Enabled`, so the flag logic under test is never the mock's. The real
 * shell is covered by `App.v2.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { V2_FLAG_KEY } from "../entry.tsx";

vi.mock("../entry.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entry.tsx")>();
  return {
    ...actual,
    AppV2: () => <div data-testid="app-v2" />,
  };
});

/** Fresh module registry, then import App so its module-scope flag read reruns. */
async function renderApp() {
  vi.resetModules();
  const { default: App } = await import("../../App.tsx");
  return render(<App />);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_CONAN_V2", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("isV2Enabled", () => {
  /** Re-imported per case: the function reads `import.meta.env` at call time,
   *  but stubbing env is cleaner against a fresh module graph. */
  async function isV2Enabled() {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("../entry.tsx")>("../entry.tsx");
    return actual.isV2Enabled();
  }

  it("is off by default", async () => {
    await expect(isV2Enabled()).resolves.toBe(false);
  });

  it("is on when localStorage conan-v2 is '1'", async () => {
    localStorage.setItem(V2_FLAG_KEY, "1");
    await expect(isV2Enabled()).resolves.toBe(true);
  });

  it("is on when the build-time VITE_CONAN_V2 flag is set", async () => {
    vi.stubEnv("VITE_CONAN_V2", "1");
    await expect(isV2Enabled()).resolves.toBe(true);
  });

  it("lets localStorage force v2 OFF in a build with the env flag baked in", async () => {
    vi.stubEnv("VITE_CONAN_V2", "1");
    localStorage.setItem(V2_FLAG_KEY, "0");
    await expect(isV2Enabled()).resolves.toBe(false);
  });

  it("falls back to v1 when localStorage throws (partitioned storage)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is not available in this context");
    });
    await expect(isV2Enabled()).resolves.toBe(false);
  });
});

describe("App flag routing", () => {
  it("mounts AppV2 when localStorage conan-v2 is set", async () => {
    localStorage.setItem(V2_FLAG_KEY, "1");
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("app-v2")).toBeInTheDocument());
  });

  it("mounts AppV2 when the env flag is set", async () => {
    vi.stubEnv("VITE_CONAN_V2", "1");
    await renderApp();

    await waitFor(() => expect(screen.getByTestId("app-v2")).toBeInTheDocument());
  });

  it("renders v1 unchanged with the flag off", async () => {
    const { container } = await renderApp();

    expect(screen.queryByTestId("app-v2")).not.toBeInTheDocument();
    // v1's own shell mounts: ChatSurface's thread sidebar, whose landmark label
    // ("…and chats") is distinct from v2's ("…and threads"), so this cannot
    // pass against the wrong UI.
    expect(
      screen.getByRole("navigation", { name: "Projects and chats" }),
    ).toBeInTheDocument();
    // …and none of v2's regions do.
    expect(container.querySelector('[data-slot="sidebar"]')).toBeNull();
    expect(container.querySelector('[data-slot="toolbar"]')).toBeNull();
    expect(container.querySelector('[data-slot="secondary-bar"]')).toBeNull();
  });
});
