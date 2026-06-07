# Conan — updates PRD

Working PRD for the next batch of Conan app updates. Stories captured one by one;
`decompose-prd` will turn this into `prd.json` for the build loop.

---

## Story 1 — Smart startup working directory + remember last cwd

**As a** Conan user, **when** I open the app, **I want** it to start in a sensible
directory and remember where I last worked, **so that** I'm never dumped into the
app's install folder.

### Verified current behavior (source)
- Active cwd is managed by `src/cwd/index.ts`. On startup `loadPersisted()`:
  - uses the persisted `DATA_DIR/active-cwd` file if present + usable, else
  - **falls back to `PACKAGE_ROOT`** → for the installed app this is the
    **install location** (`/Applications/Conan.app/Contents/Resources`). ✅ matches
    the cwd seen on every observed session.
- `/api/config` returns `cwd: getActiveCwd()` (read-only). **`setActiveCwd()` is
  never called** anywhere — there is **no cwd-picker route or UI** in the current
  app (removed with the old toolbar). So the persist-and-restore mechanism exists
  but is dormant (nothing ever changes the cwd → nothing is ever persisted).

### Requirements
- **(a) Smart default** (when no usable persisted cwd): start in **`~/.claude`**
  if it exists and is a usable dir, else the **user's home directory** (`HOME`).
  Remove the `PACKAGE_ROOT` (install-location) fallback.
- **(b) Remember last cwd**: persist the active working directory and restore it
  on next launch. Precedence on startup: **persisted cwd → smart default (a)**.

### (c) Navigation = track the terminal's cwd — DECIDED
The user changes directories by `cd`-ing in the terminal (no picker UI). Conan
**follows the active terminal's real working directory**: when the focused pty's
cwd changes, Conan adopts it as the app active cwd (`setActiveCwd`), which then
persists (b) and drives new terminals + the Tasks/Timeline scope + the StatusBar.
- **Detection approach:** prefer **OSC 7** (`\e]7;file://host/path\e\`) emitted by
  the shell on `cd` — wire a precmd/PROMPT hook so zsh/bash emit it; the pty
  reader parses OSC 7 and calls `setActiveCwd`. **Fallback:** poll the pty child's
  process cwd (node-pty pid → OS cwd lookup) on output-idle when OSC 7 is absent.
- The **active terminal** drives the app cwd; switching tabs or `cd`-ing updates
  it; the last value at close is what (b) restores.

### Acceptance criteria
- Fresh state (no `active-cwd` file): app opens with cwd = `~/.claude` if it
  exists, else `$HOME`. Never the install directory.
- `cd`-ing in the active terminal updates the app active cwd (StatusBar reflects
  it; new terminals spawn there).
- After `cd`-ing and restarting the app, it reopens in that last directory.
- A persisted-but-now-invalid dir falls back to the (a) default gracefully.
- `npm run typecheck` clean; `cd ui && npm run build` clean. Verify the StatusBar
  cwd + restart-restore with `automate-browser`.

*(Likely decomposes into: smart default (a) → cwd-tracking from the pty (c) →
persist+restore (b) → StatusBar reflects live cwd.)*

---

## Story 2 — Usage rate-limit bars always persist (empty skeleton when no data)

**As a** user, **I want** the Usage tab's rate-limit bars (Current session /
Current week …) to always be visible — as empty placeholders when there's no
data yet — **so that** the layout is consistent and I'm not left wondering where
the bars went.

### Verified current behavior (source)
- The three window rows render via `PlanWindowRow` (`Widgets.tsx`), which
  **`return null` when its window data is null** (line ~841).
- The common **`LiveUsageView`** face ("live · from /usage" — a transcript-derived
  Session block with **no recent `/usage` probe**) has `fiveHour`/`sevenDay`/
  `sevenDaySonnet` = null → all three rows return null → **no bars render**, only
  the SESSION block. ← this is the reported bug.
- A ready-made skeleton already exists — **`EmptyPlanWindowRow`** (label + `—` +
  empty `h-1.5 rounded-full bg-muted` bar + "Awaiting capture", `opacity-60`) —
  but it's only used by `EmptyUsageView`, not `LiveUsageView`.

### Requirement
- The three rate-limit window rows are **always visible**. With data → real bar +
  "X% used" + "Resets …". Without data (null) → the empty skeleton (label + empty
  bar + `—`/"Awaiting capture"), **never nothing**.

### Acceptance criteria
- In `LiveUsageView` with null windows (Session block present, no probe), the
  three window rows render as empty skeletons **above** the SESSION block.
- When a `/usage` probe later captures windows, they fill with real values.
- Behavior is consistent across all three faces (Live / Plan / Empty) — the
  window rows never disappear.
- `npm run typecheck` + `cd ui && npm run build` clean. Verify with
  `automate-browser`.

### Implementation hint
Reuse `EmptyPlanWindowRow`. Cleanest: make `PlanWindowRow` fall back to the
empty skeleton when `win` is null (instead of `return null`), so every caller
gets the persistent layout. Single small change.

---

## Story 3 — Free users get a direct "Buy Premium" → checkout action

**As a** Free user, **I want** a clear purchase button that takes me to checkout,
**so that** upgrading is one click away.

### Verified current behavior (source) — mostly already built
- Settings ▸ License **already renders a primary-styled `Buy Premium · $29`
  button for Free users** (`SettingsView.tsx` ~1238): `bg-primary
  text-primary-foreground`, `onClick → openExternal(BUY_PREMIUM_URL)`.
- It opens `BUY_PREMIUM_URL` — **currently the placeholder `https://conan.sh`**
  (`SettingsView.tsx:1048`), NOT the Polar hosted-checkout, because the Polar
  account is **still being ID-verified / not Go-Live approved**.
- Free users are routed to this tab by the existing upgrade prompts (Pulse wall,
  Timeline gate, Radio ticker → `conan:open-settings {tab:license}`).

### Decisions (2026-06-06)
- **Interim while Polar pending:** keep the button pointing at **`https://conan.sh`**
  (the marketing site, which will route to Polar later). Button stays live.
- **Prominence:** Settings ▸ License is enough — no new always-visible affordance.

### Requirement / what's actually left
- **The only true gap is the URL.** When Polar Go-Live is approved, swap
  `BUY_PREMIUM_URL` to the **real Polar hosted-checkout link** and verify the
  end-to-end checkout → license-issue flow. (Tracked as a **blocked follow-up** —
  not buildable until the Polar checkout URL exists.)
- **Optional enhancement (recommended):** make `BUY_PREMIUM_URL`
  **runtime-configurable** (env var / gateway config) instead of a hard-coded
  constant, so the Polar swap is a config change, **not a full app
  rebuild + reinstall**. (Given how heavy our release loop is, this is worth it.)

### Acceptance criteria
- Free user sees a prominent primary `Buy Premium · $29` button in Settings ▸
  License that opens `BUY_PREMIUM_URL` in the default browser. *(already true —
  regression-guard it.)*
- If the optional enhancement is taken: the checkout URL can be set without
  rebuilding the app, and defaults to `https://conan.sh`.
- `npm run typecheck` + `cd ui && npm run build` clean.

### Status
**Code requirement already satisfied.** Real completion = the Polar URL swap,
which is **blocked on Polar account approval**. Net new work this iteration is
small (regression-guard + the optional runtime-config enhancement).

---

## Story 4 — New built-in "Conan" theme (FREE), from the marketing palette

**As a** user, **I want** a "Conan" theme that matches the warm ink-&-fire look
of conan.sh, **so that** the app can wear the brand identity — and it's free for
everyone.

### Verified current behavior (source)
- Themes are `{id, name, type:"light"|"dark", tokens}` entries in
  `BUILTIN_THEMES` (`ui/src/lib/themes.ts`); `applyTheme()` sets the ~30 canonical
  tokens on `<html>` + toggles `.dark`, reskinning the **whole app + terminal**
  (terminals re-read via `getTerminalTheme()` on `THEME_APPLIED_EVENT`).
- **Gating gotcha:** `isPremiumThemeId(id)` (`SettingsView.tsx:41`) returns true
  for **anything except `light`/`dark`/`auto`** — so a new theme is **Premium by
  default**. Must be explicitly allow-listed to be free.
- Theme system handles **colors only** — not fonts or the marketing site's
  film-grain overlay (those are out of scope for this story).

### Requirements
- Add a built-in **`{ id: "conan", name: "Conan", type: "dark" }`** theme with the
  full canonical token set mapped from the conan.sh dark palette.
- **Make it FREE** — update `isPremiumThemeId` (or a new `FREE_THEME_IDS` set) so
  `conan` is not locked. It should apply for Free + Premium users alike.

### Token mapping (from conan.sh "Canonical (dark) palette")
```
background          #0c0a09     foreground          #f0e8d6
card                #1a1512     card-foreground     #f0e8d6   (bone alt #ece3d0)
muted               #231c18     muted-foreground    #a89a82
border / input      #2c2521     accent              #231c18
primary / ring      #d97706     primary-foreground  #1c1208   (EMBER)
secondary           #231c18     secondary-foreground#f0e8d6
accent-foreground   #f0e8d6     popover             #1a1512   popover-foreground #f0e8d6
destructive         #ef4444     destructive-foreground #1c1208 (verify contrast; bone if needed)
term-bg             #0c0a09     term-fg             #f0e8d6
chart-1 #e0a42b · chart-2 #d97706 · chart-3 #f0c674 · chart-4 #b45309 · chart-5 #a3341f
heat-0..4  (NOT in palette) → derive a warm ember/gold ramp, e.g.
           #231c18 → #5a3a14 → #92591a → #c8962b (gold) → #d97706 (ember)
```
Lore accents from the palette not in the canonical contract (`oxblood #7f1d1d`,
`gold #c8962b`, `bone #ece3d0`) have no direct token slot — fold where sensible
(gold→heat ramp/premium chip; oxblood already echoed by chart-5/chart-4).

### Acceptance criteria
- "Conan" appears in the Appearance picker under **Dark**, **unlocked for Free
  users** (no lock icon), and selecting it reskins the whole app + terminal warm.
- Charts (Pulse) render straw→ember→oxblood; the terminal goes `#0c0a09`/`#f0e8d6`.
- Selection persists across restart like other themes.
- `npm run typecheck` + `cd ui && npm run build` clean. Verify the applied look +
  the unlocked-for-Free state with `automate-browser`.

### Notes
Colors only — the marketing site's **film-grain texture and Geist fonts are NOT**
part of this (separate work if ever wanted). Likely decomposes into: add theme
tokens → free-gate it → verify in picker/apply.
