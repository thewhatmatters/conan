# v2 testing guide

How to run and write tests for the v2 Astryx UI. Read
[docs/v2-astryx-redesign.md](v2-astryx-redesign.md) first — it is the shared
brain; this file is only the test harness that sits under it.

The harness landed with T0 and is deliberately small: Vitest + jsdom +
Testing Library, scoped to `ui/src/v2/`. v1 has no tests and none are being
added — the point of the harness is that each v2 story can prove its own node
against the Paper artboard without a browser round-trip.

## Run

```bash
cd ui && npm run test          # one pass — the gate
cd ui && npm run test:watch    # while building a story
cd ui && npm run test -- Sidebar   # one file
```

`npm run test` runs `vitest run` against [ui/vitest.config.ts](../ui/vitest.config.ts),
which merges `vite.config.ts` (StyleX compiler + the `@` alias) and adds the
jsdom environment plus [ui/src/test/setup.ts](../ui/src/test/setup.ts).

One benign line appears at the end of every run:

```
[plugin:unplugin-stylex] context method emitFile() is not supported in serve mode.
```

Vitest runs the plugin in serve mode, so StyleX's extracted stylesheet is never
emitted. Class names still compile, which is all the tests need. Ignore it.

## What each story owes

Every story that adds or changes a v2 component ships **both** of these, or it
is not done:

| Gate | Command | Bar |
| --- | --- | --- |
| Render test | `cd ui && npm run test` | at least one test that renders the story's component and asserts against its Paper node |
| Build / typecheck | `cd ui && npm run typecheck` **and** `cd ui && npm run build` | both clean |

Browser QA against the preview stack is still the value-level check — jsdom
does not resolve `var()`, lay out flexbox, or paint. Tests catch structure and
regressions; the eye catches the design.

## Where tests go

```
ui/src/v2/__tests__/<StoryName>.test.tsx
```

One file per component or concern, named for what it covers
(`Sidebar.test.tsx`, `App.v2.test.tsx`, `tokens.test.ts`). Nothing outside
`ui/src/v2/__tests__/**` is collected — see `test.include` in the config.

The five T0 files are the pattern to copy:

| File | Covers |
| --- | --- |
| `AppFlag.test.tsx` | `isV2Enabled` precedence, and that `App.tsx` routes to v2 only when the flag is on — v1 unchanged otherwise |
| `App.v2.test.tsx` | the shell: sidebar + toolbar mount, secondary bar sits inside the content well, no second title bar |
| `Sidebar.test.tsx` | header / tree / footer compose; `NewChatButton` stays unmounted |
| `Toolbar.test.tsx` | breadcrumb before tab strip; the artboard's four surface tabs |
| `tokens.test.ts` | `tokens.css` reaches the document through `entry.tsx`, on the Astryx theme scope |

## House rules

**Query the DOM the way a user or the a11y tree would.** Prefer
`getByRole` / `getByText`; fall back to the `data-slot` attributes the v2
components already carry (`[data-slot="sidebar"]`, `"toolbar"`,
`"thread-row"`, …) for structural assertions that have no accessible name. Do
not add a `data-testid` when a `data-slot` or a role already identifies the
node — and never assert on a StyleX class name, which is a compiler artifact
that changes when the style does.

**Assert the decision, not the markup.** A test earns its keep when it pins
something a future edit could plausibly get wrong: the secondary bar living
inside the well rather than the toolbar, `NewChatButton` staying off the
artboard's footer, the flag defaulting to v1. Re-describing the JSX in
`expect` form is churn.

**Composition files test composition.** `Toolbar.test.tsx` asserts that
`Breadcrumb` and `SurfaceTabs` are mounted and ordered; it does not re-assert
their internals. That split mirrors the file-ownership contract (§4.4) — a
leaf's own suite owns its details, so parallel worktrees don't collide.

**Don't assert computed styles.** jsdom has no layout engine and does not
resolve custom properties, so `getComputedStyle(...).height` is a lie waiting
to be written. Token-level checks assert that a variable is *declared*
(`tokens.test.ts`); the value check is Paper + the browser.

**Keep the flag honest.** `App.tsx` reads `isV2Enabled()` once at module
scope, so a test that flips `localStorage` and re-renders proves nothing —
`vi.resetModules()` then re-`import()` App, as `AppFlag.test.tsx` does.

## Gotchas already paid for

- **`restoreMocks: true` eats `vi.fn()` shims.** Globals patched in
  `setup.ts` (matchMedia, `scrollIntoView`) are plain functions on purpose;
  as `vi.fn()` they get restored to undefined-returning stubs before the
  second test in a file.
- **jsdom cannot parse `@layer` / `@scope`,** which every Astryx stylesheet
  uses, and it has no canvas (the dormant xterm modules touch `getContext` at
  import time). Both log walls of stderr and break nothing, so `setup.ts`
  filters those two exact messages — and only those two.
- **Mounting the real `AppV2` loads app-GLOBAL Astryx CSS into the test
  document.** `AppFlag.test.tsx` stubs it (keeping the real `isV2Enabled` via
  `importOriginal`) so the v1 case is checked against a clean document; the
  real shell renders in `App.v2.test.tsx`.
