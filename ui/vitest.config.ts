/**
 * Vitest — the v2 UI test harness (docs/v2-testing-guide.md).
 *
 * It MERGES `vite.config.ts` rather than restating it, because the v2 tests
 * cannot run without two things that config already sets up:
 *   - the StyleX compiler plugin. Every v2 component calls `stylex.create()` at
 *     module scope, which THROWS at runtime unless a build-time plugin rewrote
 *     it ("Unexpected 'stylex.create' call at runtime"). No plugin → every v2
 *     render test fails on import, not on an assertion.
 *   - the `@` → `src` alias, so tests can import the way components do.
 * The dev-server/proxy half of that config is inert here; Vitest never listens.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // Explicit imports from "vitest" in every test file — no ambient globals,
      // so `npm run typecheck` sees the same symbols the runner does.
      globals: false,
      setupFiles: ["./src/test/setup.ts"],
      // Component suites for both mounted shells. Keeping the roots explicit
      // means a misplaced spec cannot silently look covered.
      include: [
        "src/components/__tests__/**/*.test.{ts,tsx}",
        "src/v2/__tests__/**/*.test.{ts,tsx}",
      ],
      // Real CSS processing: `tokens.test.ts` asserts that the v2 entry actually
      // injects `tokens.css`, which only happens when Vitest handles CSS instead
      // of stubbing it out.
      css: true,
      restoreMocks: true,
    },
  }),
);
