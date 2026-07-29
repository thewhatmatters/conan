# Conan v2 — Astryx Redesign · Multi-Agent Build Plan

> **Status:** planning locked, Phase 0 not yet run. Branch: `loop/conan-v2-astryx`.
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
  artboard **`App` (`4I-0`, 1512×982, dark mode)**.
  `https://app.paper.design/file/01KYQJ3S5RCDAE0KY87NRFY75F/1-0/4I-0`
  Pull EXACT values with the Paper MCP (`get_computed_styles`, `get_jsx`,
  `get_fill_image`) — **never read sizes/colors off a screenshot**; screenshots
  are for verifying, not sourcing.
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

## 3. Design reference — the shell IA (from the Paper `App` artboard)

Dark mode · font **Figtree** + system monospace. Node IDs are for the Paper MCP.

- **Sidebar (`4M-0`, 273px):**
  - Header (`70-0`): Conan logo mark + wordmark.
  - Search input with `⌘K` (`MU-0`).
  - Projects tree — collapsible **project groups** (`OT-0`, `PY-0`, `PZ-0`); rows = avatar + status dot + title + muted subtitle.
  - Footer (`7L-0`): a **New chat** button (`7W-0`); **Settings** at the very bottom.
- **Main (`4O-0`, 1239px):**
  - **Toolbar (`EK-0`):** breadcrumb `Conan / Analyze my project` (`EL-0`) + closeable **surface tabs** `Chat · Browser · Terminal · Diff · Surface` (`HL-0`).
  - **Secondary bar (`LN-0`):** `Actions ▾`, `Open ▾`, `Commit & Push`.
  - **Content (`4N-0`):** transcript/composer region (out of scope for the shell milestone — leave an empty slot).

This IA is an **evolution of v1's** (breadcrumb, kebab rows, surfaces already
exist) — a re-skin + tab-model refinement, not a from-scratch app.

## 4. Architecture & interface contracts (what makes parallelism safe)

```
ui/src/v2/
  entry.tsx        # dynamic-imports Astryx CSS; exports <AppV2/>
  App.v2.tsx       # shell composition — named slots wired to component modules
  tokens.css       # bridge layer: design values ← Paper, exposed as CSS vars
  shell/
    Sidebar.tsx    Toolbar.tsx    SecondaryBar.tsx
  components/
    SidebarHeader.tsx  SearchInput.tsx  ProjectTree.tsx  ThreadRow.tsx
    NewChatButton.tsx  SettingsFooter.tsx  Breadcrumb.tsx  SurfaceTabs.tsx
  lib/             # thin adapters reusing v1 hooks (useAgentChat, providers…)
```

**Contracts every agent honors (to avoid collisions + drift):**
1. **Flag:** `App.tsx` mounts `<AppV2/>` when `localStorage.conan-v2 === "1"` (or `import.meta.env.VITE_CONAN_V2`); otherwise the current app. v1 is default.
2. **Tokens only.** Consume `v2/tokens.css` vars (colors, radius, spacing, type). **No hardcoded hex, no Tailwind classes in v2.** Token names come from T0.
3. **Astryx only.** v2 components are built from `@astryxdesign/core`; do not import shadcn/Radix into `v2/`.
4. **Slots.** `App.v2.tsx` defines named regions (sidebar-header, sidebar-body, sidebar-footer, toolbar-crumb, toolbar-tabs, secondary-bar, content). Each component task fills ONE slot and owns ONLY its own file(s) — no edits to another task's file.
5. **Data reuse.** Wire to existing hooks via `v2/lib/` adapters; **do not** touch `src/` (gateway) or v1 components.
6. **Verify against Paper:** screenshot the built component, diff against its Paper node; pull exact values with `get_computed_styles`.

## 5. Task graph — sequential foundation → parallel fan-out

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

## 8. Open questions / risks

- **`xstyle` build plugin** — unknown until T0 renders a customized component. If required, add `unplugin-stylex` to `vite.config` (T0 owns this).
- **CSS isolation must hold** — if Astryx `reset.css` leaks into v1, v1 restyles. T0 must prove v1 is pixel-unchanged with the flag off.
- **Pre-1.0 Astryx (0.1.9)** — component names/props in the task table are *expected* categories; confirm each via the CLI before use (they may differ).
- **Figtree** — add the font in T0 (v1 uses Geist; v2 uses Figtree per the design).
- **Parity scope** — the shell milestone stops at sidebar+toolbar+empty content; transcript/composer/surfaces are a later phase, planned once the shell UX is validated.
