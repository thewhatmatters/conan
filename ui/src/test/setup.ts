/**
 * Global test setup (loaded by `vitest.config.ts` before every suite).
 *
 * Two jobs: install the jest-dom matchers, and stub the browser APIs jsdom
 * does not implement but the app touches on mount. Everything here is a
 * capability shim — no app behaviour is faked.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount between tests. Vitest doesn't do this for us (no globals), and a
// leaked tree makes the next `getByText` ambiguous instead of failing honestly.
afterEach(() => {
  cleanup();
});

// jsdom 26+ no longer exposes localStorage as a global in the Vitest jsdom
// environment, but the app uses it at import time. Provide a minimal in-memory
// store so tests that call `localStorage.clear()` work without ambient globals.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
    configurable: true,
    writable: true,
  });
}

// jsdom ships no matchMedia; v1's theme module calls it at import time.
// PLAIN functions, not `vi.fn()` — `restoreMocks` resets mock implementations
// before every test, which would silently turn these shims back into
// undefined-returning stubs partway through a run.
if (!window.matchMedia) {
  const noop = () => {};
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom's Element has no scrollIntoView; transcript/list code calls it freely.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

/**
 * Two known jsdom gaps that log walls of stderr but break nothing:
 *   - its CSS parser predates `@layer`/`@scope`, which Astryx's stylesheets are
 *     built on, so each one logs a parse error WITH THE WHOLE FILE INLINED. The
 *     <style> elements still land in the document (the token test reads them).
 *   - no canvas backend, and importing `App.tsx` pulls in the dormant xterm
 *     modules, which touch `getContext` at module scope.
 * Filtered by exact message so a real console error still surfaces.
 */
const IGNORED_JSDOM_ERRORS = [
  "Could not parse CSS stylesheet",
  "Not implemented: HTMLCanvasElement.prototype.getContext",
];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (IGNORED_JSDOM_ERRORS.some((message) => text.includes(message))) return;
  consoleError(...args);
};
