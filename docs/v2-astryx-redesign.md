# Conan v2 — Astryx Redesign · Multi-Agent Build Plan

> **Status:** **Sidebar+toolbar SHELL MILESTONE COMPLETE** (T0 + all leaf
> components + assembly landed and verified live against RJ-0). The build stories
> were pruned from `prd-conan-v2-astryx.json`; the queue now holds only remaining
> polish (US-101 shell a11y). Functional wiring is a separate Phase 2 PRD (TBD).
> Read **§8 (T0 outcomes)** for the resolved setup facts. Branch:
> `loop/conan-v2-astryx`. The §5 task graph below is retained as the historical
> plan of record.
> **This doc is the shared brain.** Any agent picking up a v2 task reads this
> FIRST. It is the single source of truth across machines (it travels via git;
> per-machine `.claude` memory does not).

## 0. Orientation (read this before touching anything)

We are building a **v2 redesign of the Conan chat UI** on **Astryx** (Meta's
React + StyleX component library), replacing shadcn/Tailwind **for v2 only**. v2
lives **beside** the current app (v1) in the same Vite project, behind a flag;
**v1 stays the default and untouched** until v2 reaches parity, because Conan is
dogfooded (we run it to build it) and must not break.

- **Design source:** Paper file `01KYQJ3S5RCDAE0KY87NRFY75F`, page `1-0`,
  artboard **`Application Shell` (`RJ-0`, 1512×1030, dark mode)**.
  `https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/RJ-0`
  Pull EXACT values with the Paper MCP (`get_computed_styles`, `get_jsx`,
  `get_fill_image`) — **never read sizes/colors off a screenshot**; screenshots
  are for verifying, not sourcing.
  ⚠️ `RJ-0` **supersedes** the older `App` artboard (`4I-0`), which is now
  `RJ-0`'s second child — so `4I-0` is still the 1512×982 app body, but the
  shell root is `RJ-0`, which adds a 48px window title bar (`RK-0`) above it.
  Node ids inside the body are unchanged. `prd-conan-v2-astryx.json`'s
  `nodeMap` has two stale entries; see §8 for the resolved reading.
- **Backend is unchanged.** v2 is presentation only. It reuses the existing
  gateway, WebSockets, and hooks (`useAgentChat`, `/ws/agent`, `/api/agent/*`).
  No `src/` (gateway) changes for the shell milestone.
- **First milestone:** the **sidebar + toolbar shell** (a live-feeling UX
  skeleton), to validate the Astryx pipeline and the look before porting
  transcript/composer/surfaces.

## 1. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Astryx is the v2 component library** (StyleX in the app). | Randy wants off shadcn/Tailwind for v2. |
| D2 | **Parallel `ui/src/v2/` shell, same Vite app, behind a flag.** Not a separate repo. | Keeps the gateway/WS wiring shared; v1 keeps working. |
| D3 | **v1 stays default & visually untouched** until v2 parity, then cut over `App.tsx`. | Dogfooding — can't break the app we build in. |
| D4 | **First deliverable = sidebar + toolbar shell.** | Validate pipeline + UX early. |

## 2. Astryx setup runbook (verified against npm + docs, 0.1.9)

**Packages** (all real on npm, **v0.1.9 — pre-1.0, expect API churn**):

```bash
cd ui && npm install @astryxdesign/core @astryxdesign/theme-neutral \
  @astryxdesign/cli @stylexjs/stylex
```

- `@astryxdesign/core` peers: **react ≥19**, **react-dom ≥19**, **`@stylexjs/stylex` ^0.19** (required peer — install it). We are on React 19 / **Vite 6** → compatible.
- **No `ThemeProvider`.** Theming is three global CSS imports:
  ```css
  @import '@astryxdesign/core/reset.css';
  @import '@astryxdesign/core/astryx.css';
  @import '@astryxdesign/theme-neutral/theme.css';
  ```
- Astryx ships **precompiled StyleX CSS**, so **consuming** its components needs **no build plugin**.
- **`xstyle` prop** = per-component customization. *Authoring* custom StyleX MAY need `unplugin-stylex`/the StyleX Vite plugin — **resolve in T0**; add the plugin only if `xstyle` compilation is actually required.
- Components import per-path: `import {Button} from '@astryxdesign/core/Button'`, `import {VStack} from '@astryxdesign/core/Layout'`.

**⚠️ CSS-isolation rule (critical, or we break v1):** `reset.css`/`astryx.css`
are app-global and would fight v1's Tailwind preflight. **Load the Astryx CSS by
dynamic import inside the v2 entry only**, so it is injected solely when the flag
routes to v2. Never add the Astryx `@import`s to v1's `index.css`.

**Astryx docs = the CLI (no MCP).** Each agent gets exact component APIs itself:

```bash
npx astryx init                         # generates AGENTS.md / CLAUDE.md agent docs
npx astryx component <Name> --props --json   # exact props/usage/source for a component
npx astryx docs tokens --json           # the design-token surface
npx astryx search <term>                # find the right component
```

## 3. Design reference — the shell IA (from the Paper `RJ-0` artboard)

Dark mode · font **Figtree** + system monospace. Node IDs are for the Paper MCP.
Measurements below were read with `get_computed_styles` / `get_jsx` in T0 — they
are exact, not approximate.

- **Window title bar (`RK-0`, 48px, `#111111`):** macOS traffic lights +
  `Conan` wordmark (14/600) + a sidebar-collapse toggle. **Not rendered** — see
  §8; the Tauri window is decorated, so this is the artboard's mock of native
  chrome.
- **App body (`4I-0`, 1512×982, `#1B1B1B`, 16px bottom corners).**
- **Sidebar (`4M-0`, 273px, `#1B1B1B`, `space-between`):**
  - Header (`70-0`, **64px**): holds the **search field only**. The logo/wordmark
    moved to `RK-0`.
  - Search input (`MU-0` / `RV-0`): `#262626` on a 1px `#525252` border, 10px
    radius, 4/8 padding; leading search icon + `Search` placeholder + two `⌘`/`K`
    key caps (20px, 6px radius, `#FFFFFF1A`, 2px bottom edge).
  - Projects tree (`OT-0`): a `Projects` section header (14/500 **`#FFFFFF`**,
    32px row) with sort + add-project icon actions, then collapsible **project
    groups** (`PY-0` open, `PZ-0` closed). An open group takes the open-flap
    folder in `#737373`; a closed one takes a plain folder in `#A3A3A3`.
  - Thread rows (**68px**, 12px padding, 10px radius, 8px apart): 40px provider
    avatar (`#FFFFFF1A`, 10px radius) + 12px status dot (`#9FE59B`, 2px `#292929`
    ring, offset off the avatar's top-right) + title (14/600 `#FAFAFA`) + subtitle
    (12/400 `#A3A3A3`, 110% leading). Selected = `#A3A3A31A` wash **and** a 2px
    `#EBEBEB` bar on the bottom edge, inset 12px.
  - Footer (`7L-0`, 16px inset): a `gap: 4` row (`7M-0`) holding pill buttons
    (32px tall, 16px radius, 8/12 padding) — `7W-0` is **Settings**.
- **Main (`4O-0`, 1239px):**
  - **Toolbar (`EK-0`, **64px** = 16px inset around a 32px row):** breadcrumb
    `Conan / Analyze my project` (`EL-0` — parent crumb + folder icon + separator
    all `#737373`, leaf `#FFFFFF`) + **surface tabs** (`HL-0`, 2px gutter): each
    32px / 10px radius / 12px inline padding; `Chat` is permanent and selected
    (`#DDDDDD1A` wash, `#FFFFFF` icon, 14/600 `#FAFAFA`), `Browser · Terminal ·
    Diff` are closeable (`#A3A3A3` + ✕), then a `Surface ▾` opener at 20% opacity.
  - **Content well (`4N-0`, `#262626`, 24px **top-left corner only**):** the one
    lifted surface. Getting that single asymmetric corner right is most of what
    makes the shell read as the design.
  - **Secondary bar (`LN-0`, **64px**, inside the well):** `Actions ▾` (14/**600**)
    left; `Open ▾` and `Commit & Push ▾` (14/400) right — the weight asymmetry is
    the artboard's, marking Actions as the primary verb.
  - Transcript/composer fill the rest of the well (out of scope for the shell
    milestone — leave an empty slot).

This IA is an **evolution of v1's** (breadcrumb, kebab rows, surfaces already
exist) — a re-skin + tab-model refinement, not a from-scratch app.

## 4. Architecture & interface contracts (what makes parallelism safe)

```
ui/src/v2/
  entry.tsx        # dynamic-imports Astryx CSS; exports <AppV2/>
  App.v2.tsx       # shell composition  ── T0 + T6 only
  Sidebar.tsx      # sidebar region      ── T0 + T6 only
  Toolbar.tsx      # toolbar region      ── T0 + T6 only
  tokens.css       # bridge layer: design values ← Paper, exposed as CSS vars
  fonts.css        # self-hosted Figtree
  components/      # ONE leaf per file — each owned by exactly one task
    SidebarHeader.tsx  SearchInput.tsx  ProjectTree.tsx  ThreadRow.tsx
    NewChatButton.tsx  SettingsFooter.tsx  Breadcrumb.tsx  SurfaceTabs.tsx
    SecondaryBar.tsx
  lib/             # thin adapters reusing v1 hooks (useAgentChat, providers…)
```

T0 wires the three composition files to import the leaves **directly** — there is
no slot-props indirection. A later task implements its leaf in place and the shell
picks it up with no edit to a shared file, which is the property that makes the
parallel worktrees safe.

**Contracts every agent honors (to avoid collisions + drift):**
1. **Flag:** `App.tsx` mounts `<AppV2/>` when `localStorage.conan-v2 === "1"` (or `import.meta.env.VITE_CONAN_V2`); otherwise the current app. v1 is default.
2. **Tokens only.** Consume `v2/tokens.css` vars (colors, radius, spacing, type). **No hardcoded hex, no Tailwind classes in v2.** Token names come from T0.
3. **Astryx only.** v2 components are built from `@astryxdesign/core`; do not import shadcn/Radix into `v2/`.
4. **One leaf, one owner.** Every region is a file under `v2/components/`, imported directly by `App.v2.tsx` / `Sidebar.tsx` / `Toolbar.tsx`. Each component task rewrites ONLY its own leaf — **no edits to the three composition files** (T0 and T6 own those) and none to another task's leaf. Leaves keep their own `stylex.create` rather than sharing a "shell control" primitive: nicer code would put five worktrees on one file, and duplication is the cheaper trade.
5. **Data reuse.** Wire to existing hooks via `v2/lib/` adapters; **do not** touch `src/` (gateway) or v1 components.
6. **Verify against Paper:** screenshot the built component, diff against its Paper node; pull exact values with `get_computed_styles`.
7. **Every task spec links its Astryx components** — each story's `notes` names the components it needs with a doc-page URL (`https://astryx.atmeta.com/components/<PascalCaseName>`) AND the authoritative CLI (`npx astryx component <Name> --props --json`). URLs are best-effort (0.1.9); if one 404s, `npx astryx search <term>` / the CLI is ground truth.

## 5. Task graph — sequential foundation → parallel fan-out

> **Executable form:** these tasks are spec'd as stories in
> [`prd-conan-v2-astryx.json`](../prd-conan-v2-astryx.json) (the Paper design
> link + per-slot node IDs + acceptance criteria live there). Feed it to
> `run-tasks.sh` (`PRD=prd-conan-v2-astryx.json ./run-tasks.sh`) or hand each
> `userStory` to an Orca worktree. Priorities encode the dependency order:
> **1 = T0 barrier**, **2 = T1–T5 parallel**, **3 = T6 integration**.


**T0 — Foundation (SEQUENTIAL, one agent, blocks everything).**
Install packages; add `v2/entry.tsx` with dynamic Astryx CSS import; add the flag
to `App.tsx` (v1 default); run `npx astryx init` + commit the generated agent
docs; extract the Paper palette/type/spacing into `v2/tokens.css`; scaffold
`App.v2.tsx` with the **named slots** as empty placeholders; smoke-render a
`VStack`+`Button`; **resolve the `xstyle`/StyleX-plugin question**. Gate: `cd ui
&& npm run build` clean, v1 unchanged, screenshot of the smoke render + empty
shell.

**Then fan out (parallel — each on its own Orca worktree, distinct files):**

| Task | Slot / files | Astryx components (query via CLI) | Depends on |
|---|---|---|---|
| T1 | Sidebar header + search — `SidebarHeader.tsx`, `SearchInput.tsx` | Text, Icon, Input/SearchField, HStack | T0 |
| T2 | Project tree + thread rows — `ProjectTree.tsx`, `ThreadRow.tsx` | Collapsible/Tree, Avatar, Badge/StatusDot, Text | T0 |
| T3 | New-chat + settings footer — `NewChatButton.tsx`, `SettingsFooter.tsx` | Button, Menu, Icon | T0 |
| T4 | Toolbar breadcrumb + surface tabs — `Breadcrumb.tsx`, `SurfaceTabs.tsx` | Breadcrumbs, Tabs (closeable), Icon | T0 |
| T5 | Secondary bar — `SecondaryBar.tsx` | Button, Menu/Dropdown, Icon | T0 |
| T6 | **Shell assembly** — compose T1–T5 into `App.v2.tsx`, responsive + spacing polish, wire flag end-to-end | Layout (HStack/VStack/Grid) | T1–T5 |

T1–T5 are independent (separate files, separate slots) → true parallel. T6 is the
integration pass and runs after they land.

## 6. Gates (every task, before "done")

- `cd ui && npm run build` clean (tsc + vite).
- **v1 untouched:** no diffs to `ui/src/index.css` Astryx-wise, no v1 component edits, no `src/` (gateway) edits.
- v2 uses **Astryx components + `v2/tokens.css` only** (no shadcn, no raw hex).
- **Visual check:** screenshot the component, compare to its Paper node; exact values via `get_computed_styles`.
- Commit on the task's worktree; target branch `loop/conan-v2-astryx`.

## 7. Orca / Hermes orchestration notes

- **Base branch:** `loop/conan-v2-astryx`. All worktrees branch from it and merge back to it; **cut over to `main` only after v2 parity** (mirrors the repo's loop→main pattern).
- **Order:** run **T0 alone first** (it's a hard barrier — the pipeline, flag, tokens, and slots must exist). Then fan **T1–T5** across worktrees. Then **T6** integrates.
- **Conflict avoidance:** the only shared files are `App.tsx` (flag, T0) and `App.v2.tsx` (slots defined in T0, filled in T6) — keep T1–T5 in their own component files so parallel worktrees don't touch the same file. See the `orca-cli` skill for worktree/terminal ops.
- **Per-agent onboarding:** point each agent at THIS doc + `docs/chat-v1-qa-backlog.md` for v1 behavior parity, and have it run `npx astryx component <X> --props --json` for the components its slot needs.
- **Gateway rule still applies:** never run the :3747 gateway from an agent session (it dies on teardown). Browser-QA uses a throwaway port stack; never touch a human's :3747/:5173.

## 8. T0 outcomes — read before starting T1–T5

T0 landed. The questions §9 opened are answered below; treat these as decided.

| Question | Answer |
|---|---|
| **`xstyle` / StyleX plugin** | **Required.** Astryx components ship precompiled, but app-authored `stylex.create()` throws at runtime (`"Unexpected 'stylex.create' call at runtime"`). `unplugin-stylex/vite` is now in `ui/vite.config.ts`; it is a no-op for v1. Use `xstyle` freely. |
| **CSS isolation** | **Holds, both directions.** Verified on the production build: with the flag off only `index-*.css` loads and zero Astryx stylesheets are fetched. `ui/src/index.css` has no diff. |
| **Figtree** | Self-hosted in `v2/fonts.css` (400/500/600/700), loaded only from `v2/entry.tsx`. `theme-neutral` already resolves `--font-family-body` to Figtree, so it applies with no extra wiring. v1 keeps Geist. |
| **Dark mode** | v2 is dark. `entry.tsx` stamps `data-astryx-theme="neutral"` + `data-theme="dark"` on `<html>`; **without the first attribute every Astryx component renders unstyled, silently.** |
| **Astryx 0.1.9 component names** | `Layout` / `LayoutPanel` / `VStack` / `HStack` all come from `@astryxdesign/core/Layout`; every component also has its own subpath (`@astryxdesign/core/Text`, `/HStack`, …). Confirm anything else with `npx astryx component <Name> --props` before use. |
| **RJ-0 was drawn on the Astryx scale** | The single most useful T0 finding. `theme-neutral`'s **dark** arm already carries most of the artboard verbatim: `--color-background-body` = `#1B1B1B`, `-surface` = `#262626`, `--color-text-primary` = `#FAFAFA`, `-secondary` = `#A3A3A3`, `--color-border-emphasized` = `#525252`, `--color-success` = `#9FE59B`, `--color-accent` = `#EBEBEB`, `--radius-element` = 10px, `--radius-inner` = 6px, `--font-size-base` = 14px, `--font-size-sm` = 12px, body leading = 1.4286 (the artboard's 142.86%). **So `<Text>` needs no typography escapes** — `color="primary"/"secondary"`, `type="body"/"supporting"` and `weight` hit the artboard's values directly. `tokens.css` aliases the theme var via `var()` rather than copying hex, so nothing freezes. |
| **Icons** | Astryx's `Icon` registry is ~26 semantic names (`close`, `chevronDown`, `search`, …) and does not cover the artboard's set (folder, zap, terminal, git-commit, layers, …). RJ-0's icons **are lucide** — the exported 16-viewBox paths scale 1:1 off lucide's 24-viewBox originals — and `lucide-react` is already a dependency. v2 uses it directly, sized `16` with colour inherited via `currentColor`. This is not a shadcn/Radix import and does not breach the Astryx-only rule. |
| **Custom tones** | `Text`'s `color` prop has no `#FFFFFF` or `#737373` step, and its `xstyle` is documented as layout-only (`TextXStyleAllowed`). The sanctioned pattern: the wrapping `HStack` sets `color` from a `--conan-*` token via `xstyle`, and the `Text` takes `color="inherit"`. The icon beside it picks up the same value through `currentColor`, so label and icon can never drift. |

Two things every downstream task must know:

- **v1's Tailwind is still in the document in v2** (`main.tsx` imports
  `index.css` statically, kept that way so v1 keeps its render-blocking
  `<link>` and no FOUC). Its layered rules lose to Astryx, but the handful it
  declares *unlayered* — `:root{color-scheme:light}` and `body{font-family /
  background / color}` — beat everything, and silently rendered the shell
  light-mode in Geist until T0 caught it. `v2/tokens.css` ends with a
  documented block that overrides exactly those three by specificity. **If you
  hit a style that "won't take" in v2, suspect an unlayered v1 rule first.**
- **`dist/assets/stylex.css` is emitted as a global `<link>`,** so v1 also
  loads it (~0.4 kB of atomic classes no v1 element carries — inert, measured).

### Three places T0 deliberately departed from `prd-conan-v2-astryx.json`

The PRD's `nodeMap` predates `RJ-0`. Where it and the artboard disagree, T0
followed the **artboard** and flagged it rather than inventing UI. Each is
recorded in the relevant file's header comment too.

1. **No sidebar logo.** The PRD gives `SidebarHeader` as "logo mark + Conan
   wordmark" (node `70-0`). On RJ-0 the wordmark lives in the title bar `RK-0`
   and `70-0` holds nothing but the search field. `SidebarHeader.tsx` therefore
   draws the 64px band and composes `SearchInput`. **T1 should not add a logo.**
2. **`7W-0` is Settings, not New chat.** The PRD labels it "New chat button
   `7W-0`"; the artboard's footer holds Settings alone. `NewChatButton.tsx` is
   drawn in `7W-0`'s exact idiom (32px, 16px pill, 8/12 padding, 16px icon +
   14/500 label) and seated beside Settings in `7L-0`'s `gap: 4` row — a row
   built for more than one button. If the artboard later gains a real New-chat
   treatment, that one file changes.
3. **The title bar is not rendered.** `src-tauri/tauri.conf.json` sets no
   `decorations: false`, so the Tauri window already has a native macOS title
   bar; painting `RK-0`'s traffic lights below it would be a non-functional lie.
   `--conan-color-titlebar` and `--conan-control-{close,minimize,maximize}` are
   in `tokens.css` for the day we do go undecorated. `RK-0`'s one piece of real
   app UI — the sidebar-collapse toggle — is unclaimed; give it to T6 or a
   follow-up.

### T0 verification actually performed

| Check | Result |
|---|---|
| `cd ui && npm run typecheck` / `npm run build` | Clean. |
| Shell measured in Chromium at 1512×982 | Matches RJ-0 exactly: sidebar 273×982, toolbar 64, secondary bar 64, sidebar header 64, thread rows 241×68, tabs 32/10px, selected wash `rgba(163,163,163,.1)`, tab wash `rgba(221,221,221,.1)`, field `#262626` + 1px `#525252`, well radius `24px 0 0`. Zero console errors. |
| v1 with the flag off | `data-astryx-theme` absent, **zero** Astryx stylesheets, `--conan-*` unresolved, `color-scheme: light`, Geist. No v2 markup. Zero console errors. |
| **WebKit 26.4** (Playwright's engine — same family as the WKWebView Tauri uses on macOS 26) | Renders identically. `@scope` and `light-dark()` both supported — the two features the Astryx theme depends on. |
| `npm run tauri:dev` | ❌ **Could not run.** No Rust toolchain on this machine (`cargo`/`rustc`/`~/.rustup` all absent, no `src-tauri/target`); `tauri dev` exits at `failed to run 'cargo metadata'`. This is an environment gap, not a code defect — the WebKit pass above is the closest available substitute. **Whoever has a Rust toolchain should run the 30-second `tauri:dev` smoke before T6.** |

## 9. Open questions / risks

- ~~**`xstyle` build plugin**~~ — resolved in T0, see §8.
- ~~**CSS isolation must hold**~~ — proven in T0, see §8.
- ~~**Paper access**~~ — resolved. The Paper MCP **was** available for the T0
  redo: every colour, radius, and bar height in `v2/tokens.css` is now read from
  `RJ-0` with `get_computed_styles` / `get_jsx` and labelled with its node id.
  No `@paper-todo` markers remain. (Paper's `get_screenshot` returned no image in
  that session, so visual comparison was done against the exported node styles
  plus rendered screenshots of our own build — which is the prescribed direction
  anyway: never source values from a screenshot.)
- **Tauri dev shell unverified** — see the §8 table. No Rust toolchain on the
  build machine, so `npm run tauri:dev` could not run; WebKit 26.4 stands in.
  Note `src-tauri/tauri.conf.json` hard-codes `devUrl: http://localhost:5173`, so
  the Tauri smoke test must use **5173** (not a throwaway UI port) and needs
  `VITE_CONAN_V2=1` in the environment of `npm run tauri:dev` for the flag to be
  on inside the window.
- **Pre-1.0 Astryx (0.1.9)** — component names/props in the task table are *expected* categories; confirm each via the CLI before use (they may differ).
- **StyleX compiler version skew** — `unplugin-stylex@0.6.3` pins
  `@stylexjs/babel-plugin@0.18.x` while the runtime is `@stylexjs/stylex@0.19.0`.
  Verified working in dev and in the production build; if compiled styles ever
  go missing after a bump, pin the babel plugin to match the runtime first.
- **Parity scope** — the shell milestone stops at sidebar+toolbar+empty content; transcript/composer/surfaces are a later phase, planned once the shell UX is validated.

## 10. Phase 2 roadmap & PRD index

The shell is done but **hollow** — everything functional (and the content well
itself: transcript + composer) is still absent. Phase 2 builds the heart and
wires the chrome to real data. It reuses v1's existing data layer (`useAgentChat`,
`/ws/agent`, `/api/agent/*`) through adapters in `ui/src/v2/lib/`; **the gateway
and v1 stay unchanged** — v2 is still presentation only.

**Sequencing principle:** prove the live loop with the smallest possible slice
BEFORE fanning out. The biggest unknown isn't "can Astryx render X" (the shell
settled that) — it's whether the streaming/WS data flow integrates cleanly in the
new shell. So the first PRD is a **walking skeleton**, and the rest parallelize
only after it lands.

| PRD | Scope | Status |
|---|---|---|
| `prd-v2-p2a-chat-core.json` | **Walking skeleton** — thread select → live streamed text transcript → minimal composer → send → reply, verified end-to-end | **ACTIVE** |
| `prd-v2-p2b-transcript-rich.json` | Rich transcript — tool cards, plan/approval UI, markdown, the activity spine, work-log rollups | planned |
| `prd-v2-p2c-composer.json` | Full composer — attachment drawer/pins, branch chip, provider·model·effort picker, @// input | **READY** (drafted vs `S5-0`) |
| `prd-v2-p2d-shell-live.json` | Wire the chrome — real projects/threads + live WS status, breadcrumb, new-chat/settings, git actions (Actions/Open/Commit&Push) | planned |
| `prd-v2-p2e-surfaces.json` | Browser · Terminal · Diff · Files in the tab model | planned |
| `prd-v2-p2f-settings.json` | Settings dialog | planned |
| `prd-v2-p2g-command-palette.json` | ⌘K command palette (Astryx CommandPalette) — search threads/projects + actions; the sidebar Search field opens it. Ties into p2d's data. | **READY** (drafted vs `VC-1`) |

**⚠️ Design gap:** `RJ-0` draws the content well EMPTY — there is **no pixel
design for the transcript or composer yet**. p2a is functional-only (token-styled
minimal). **p2b/p2c need their own Paper frame(s)** (or an explicit decision to
adapt v1's look) — that's a dependency on Randy before those PRDs can hit real
fidelity. p2a can proceed without it. (The composer design lives in a dedicated
`Chat Composer` frame — `S5-0` — and is built entirely from Astryx components.)

### Astryx chat kit — COMPOSE, don't hand-roll

Astryx ships a full **Chat** category (15 components, `import … from
'@astryxdesign/core/Chat'`) that covers our entire transcript + composer —
including things we hand-built in v1 (frosted composer dock, jump-to-present,
@//-autocomplete, streaming). Confirm props with `npx astryx component <Name> --json`.

| Astryx | Our feature | Phase |
|---|---|---|
| `ChatLayout` (+ `ChatLayoutScrollButton`) | frosted composer dock · auto-scroll · **jump-to-present** | p2a (free) |
| `ChatMessageList` / `ChatMessage` / `ChatMessageBubble` / `ChatTokenizedText` | transcript rows + streamed body | p2a |
| `ChatMessageMetadata` / `ChatSystemMessage` | per-turn footer · plan/status separators | p2b |
| `ChatToolCalls` | tool cards | p2b |
| `ChatComposer` / `ChatComposerInput` / `ChatSendButton` | composer + rich input (**@// typeahead = our autocomplete**, history, paste/drop) + send/stop | p2a |
| `ChatComposerDrawer` / `ChatComposerTokenElement` | pins drawer + pin chips | p2c |
| `ChatDictationButton` | voice dictation (new) | p2c/opt |

The per-story component list + exact links live in
`prd-v2-p2a-chat-core.json` → `astryxChatComponents`.
