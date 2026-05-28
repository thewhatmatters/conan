# Conan — QA regression checklist

Methodical regression pass over everything shipped in the Tauri terminal-wrapper
(v4.1 → v4.4). Run this **after each change set / before merging a loop branch**
to catch regressions. Most checks are browser-automatable against the Vite dev
surface; a few are native-shell-only (menu bar, OS notifications, sidecar
lifecycle) and must be run in the built/`tauri dev` app.

## Legend
- **🌐 auto** — verifiable via the `automate-browser` skill against `http://localhost:5173`.
- **🖥 native** — Tauri-only (native menu / OS notification / sidecar); run in the app.
- **☀️🌙** — verify in **both** light and dark theme.
- Each item: `[ ]` unchecked → `[x]` pass → `[!]` fail (note the failure inline).

## How to run

### Browser-automated pass (the bulk of it)
```bash
# 1. Clean state + start the gateway (no watch) and Vite
sqlite3 .data/conan.db "DELETE FROM terminal_session;"   # avoids the reattach crash (see Watch-list W1)
npm start &                 # gateway on :3747
(cd ui && npm run dev &)    # Vite on :5173  (IPv6 — use http://localhost:5173, NOT 127.0.0.1)
```
Then drive `http://localhost:5173` with the `automate-browser` skill: navigate,
click tabs/buttons, screenshot, assert the **Expected** column. Toggle dark via
the OS appearance or by forcing `prefers-color-scheme` (theme preference must be
`auto`) — or run the native app for the menu-driven Light/Dark toggle.

> Headless caveat: **audio cannot be asserted** — verify the Radio player *state*
> and controls, not sound. The gateway must be reachable or the app hangs on
> "connecting…".

### Native pass (🖥 items)
Build + run the app (`CI=true npm run tauri:build`, or `npm run tauri:dev` with
`PATH="$HOME/.cargo/bin:$PATH"`). **Rebuild the sidecar after any `src/**` change**
(`npm run build:sidecar`) — `tauri dev`/HMR only refreshes the frontend, so the
bundled gateway is stale otherwise (see Watch-list W2).

---

## 1 · Startup & shell  (v4.1/v4.3)
- [ ] 🌐 App loads at :5173: terminal pane fills the main area, HUD docked right; no permanent "connecting…".
- [ ] 🌐 Startup race: with the gateway slow/late, the app still resolves once `/api/config` answers (config-retry loop), not stuck on "connecting…".
- [ ] 🖥 Sidecar lifecycle: launching `Conan.app` boots the gateway on :3747; **quitting frees :3747** (stdin-EOF watchdog) — relaunch doesn't hit "already running".
- [ ] 🖥 Single-instance: a 2nd gateway on :3747 exits with a clear message, not a raw `EADDRINUSE` stack.

## 2 · Terminal pane & tabs  (v4.3 US-009, US-017)
- [ ] 🌐 A terminal tab strip renders (VS-Code style: flat, 1px top accent + darker bg on the active tab, no pill).
- [ ] 🌐 `+` opens a new terminal tab and switches to it.
- [ ] 🌐 Clicking the `×` on a tab closes it; closing the last tab spawns a fresh one (never zero terminals).
- [ ] 🌐 Switching tabs preserves each terminal's scrollback (tab switch is visual, never a pty kill).
- [ ] 🌐 Each tab's pty auto-launches `claude` in the repo cwd.
- [ ] 🖥 `File ▸ New Terminal` (⌘T) / `Close Terminal` (⌘W) drive the same tab actions.

## 3 · Session header  (v4.4 US-008)
- [ ] 🌐☀️🌙 A pinned header sits above the terminal body (between tab strip and xterm) — 3 lines: logo + `Conan <ver> · Claude Code v<ver>`, `Opus 4.7 (1M context)` (model + window), and the `~`-collapsed cwd.
- [ ] 🌐 Both versions show; Claude Code version is `—` only when the session never reported it (uncorrelated), never fabricated.
- [ ] 🌐 Header follows the **active terminal tab's** session (switch tabs → header repoints); uncorrelated tab shows the graceful fallback (model line muted), not a blank bar.
- [ ] 🌐 1px bottom border; no layout shift; the terminal body is unaffected.

## 4 · HUD panel  (v4.1/v4.3)
- [ ] 🌐 Tab strip reads: **Context · Usage · Pulse · [Plan] · Skills · MCP** (Plan only when a plan is active); VS-Code styling matches the terminal strip.
- [ ] 🌐 Drag the left edge resizes the HUD; width persists across reload (localStorage).
- [ ] 🖥 `View ▸ Hide HUD` (⌘⇧H) hides/shows the panel; tab state survives the toggle (HUD stays mounted).
- [ ] 🌐 The session-scoped tabs (Context, Plan, Skills) follow the **active terminal tab** (v4.4 US-003): open a 2nd terminal → they repoint; switch back → they follow.

## 5 · Context tab  (v4.2 US-009, v4.3 US-013, v4.4 US-006 + toolbar redesign)
- [ ] 🌐☀️🌙 Live face renders the exact `/context` breakdown (ring %, model, per-category rows incl. Free space) when a capture exists; on-disk `≈ estimated` fallback otherwise.
- [ ] 🌐 1M-context sessions show the correct low % (e.g. ~3% on a 1M window), not ~99%.
- [ ] 🌐 `↻ /context` manual refresh appears only when a live pty is correlated; clicking it captures + updates (shows "capturing…").
- [ ] 🌐 **Auto** toggle (`Auto ✓` / `Auto ○`) sits inline with the refresh button; toggling persists across reload; tooltip notes it spends context to measure context.
- [ ] 🌐 **Context-pressure toolbar is pinned at the TOP** of the tab (under the tab strip), always visible.
  - [ ] `< 80%`: neutral/muted, label `Context N%`, both actions disabled.
  - [ ] `80–95%`: red `Context N% — running low`; **Remind me later** enabled (click → snoozes back to calm) and **Compact** enabled (needs live pty).
  - [ ] `≥ 95%`: red `Context N% — critical`; **Remind me later disabled**, Compact the only action.
  - [ ] Compact `POST`s `/handoff` to the correlated pty (disabled with a tooltip when no live pty); copy states the session writes HANDOFF.md.

## 6 · Usage tab  (v4.2 US-010)
- [ ] 🌐☀️🌙 Renders the Session block + all 3 rate-limit windows when a `/usage` capture exists; honest approximation/empty state otherwise.
- [ ] 🌐 Refresh path works when a live pty is correlated; no crash when none.

## 7 · Pulse tab  (v4.2 charts, v4.4 US-005)
- [ ] 🌐☀️🌙 Stacked area chart renders across sessions; range toggle **15m / 1h / 6h / 24h** re-buckets.
- [ ] 🌐🌙 **Axis tick labels are legible in dark mode** (the v4.4 fix — not the old dim `muted-foreground`).
- [ ] 🌐 Hover tooltip does **not** collide with a legend (the redundant in-chart legend was removed); the footer legend + per-category totals (`N tools · N prompts · …`) are intact.
- [ ] 🌐 Hover cursor line is theme-aware (not a hard-coded grey).
- [ ] 🌐 Empty window shows "No activity in this window yet."

## 8 · Plan tab  (v4.3 US-004)
- [ ] 🌐 Tab appears **only** when the active session has a live plan (TodoWrite items / recent ExitPlanMode / active build loop); absent otherwise.
- [ ] 🌐 Renders the plan items; build-loop tasks feed the fallback.

## 9 · Skills tab  (v4.3 US-006)
- [ ] 🌐☀️🌙 Lists installed skills (name + description from SKILL.md frontmatter, never fabricated).
- [ ] 🌐 **User / System** group toggle works; counts are correct (User+Project vs Plugin+Built-in).

## 10 · MCP tab  (v4.4 US-007, fixed to `claude mcp list`)
- [ ] 🌐☀️🌙 Lists the configured MCP servers with live status from `claude mcp list` (NOT hooks): name + url/transport + a StatusDot.
- [ ] 🌐 Status colors map correctly: Connected → green, Failed → red, Needs authentication / pending → amber.
- [ ] 🌐 Header shows the count; `↻ refresh` re-checks health (`?force=1`); loading shows "Checking MCP server health…".
- [ ] 🌐 Graceful states: "No MCP servers configured." (none) / "Couldn't read MCP servers: …" (binary missing/timeout).
- [ ] _Note:_ this list is **global** (account-wide), not per-session — it does not follow the active tab (by design).

## 11 · Bottom status bar  (v4.4 US-004)
- [ ] 🌐☀️🌙 cwd hugs the **left**, git branch hugs the **right** (`~`-collapsed cwd, both truncate).
- [ ] 🌐 Dirty tree shows a bare `*` on the branch (`branch*`); clean tree shows the plain branch — **no numeric count**, **no gateway chip**.

## 12 · Claude Radio  (v4.4 US-011, in the HUD)
- [ ] 🌐☀️🌙 Toolbar pinned at the **bottom of the HUD panel** (not full-width app strip): play button + radio icon + "Claude Radio".
- [ ] 🌐 Starts **paused**; clicking Play flips to Pause and the player state reflects PLAYING (real `onStateChange`, not optimistic); Pause flips back.
- [ ] 🌐 Offline/ended stream → control disabled with "Claude Radio — offline".
- [ ] 🌐 **Equal height** with the status bar (both `h-7`, same `text-xs`, same `size-3.5` icons).
- [ ] _Note:_ hiding the HUD also stops Radio (player unmounts with the panel).

## 13 · Settings dialog  (v4.3 US-007/008, v4.4 US-009/010)
- [ ] 🖥 `Conan ▸ Settings…` (⌘,) opens the dialog (🌐 also openable via the `conan:open-settings` event in dev).
- [ ] 🌐☀️🌙 Two tabs: **Status** (read-only: version, session, cwd, login/org/email, model, MCP servers, setting sources) and **Config**.
- [ ] 🌐 Config rows are live controls by type: toggle for booleans, dropdown for enums (allowed values), text/number otherwise.
- [ ] 🌐 Changing a control persists via `POST /api/claude/config` and survives reopen; **only that key changes** (other settings/permissions/hooks/mcp preserved); errors surface inline.
- [ ] 🌐 Each editable control notes changes may only take effect next Claude session (no false hot-reload claim).

## 14 · Native menu & theme  (v4.3 US-011, v4.4)
- [ ] 🖥 Menu bar: **Conan** (About, Settings… ⌘,, Hide, Quit) · **File** (New/Close Terminal) · **Edit** (Undo/Redo/Cut/Copy/Paste/SelectAll work in terminal + HUD) · **View** (Theme, Hide HUD) · **Help**.
- [ ] 🖥 `View ▸ Theme` radio submenu (Light / Dark / Auto — match system); the checkmark follows the active choice.
- [ ] 🌐☀️🌙 Switching theme recolors HUD + charts + terminal in lockstep; `Auto` follows the OS appearance live (matchMedia).
- [ ] 🌐 Light is the default.

## 15 · Native notifications  (v4.2 US-011)
- [ ] 🖥 A Claude `Notification` hook surfaces a native macOS notification; clicking it focuses Conan and jumps to the prompting session's terminal tab.
- [ ] 🖥 A prompt for the **visible** correlated session while Conan is focused is suppressed (you see it live in the terminal).

## 16 · Data pipeline & WS  (v1/v2/v3 foundations)
- [ ] 🌐 Sessions list populates from `/api/claude/sessions`; live events advance it over the app WS without a manual reload.
- [ ] 🌐 Pulse/Context/Usage re-pull after a WS reconnect (reconnect-seq trigger).
- [ ] 🌐 Hook ingestion: a hooked `claude` in this repo self-reports over `/ws`; events appear (token honors `CONAN_DATA_DIR`).
- [ ] 🌐 Both WS endpoints (`/ws`, `/ws/terminal`) authenticate on upgrade (token + Origin); an unauthed/cross-origin upgrade is rejected.

## 17 · Build gates  (every change)
- [ ] `npm run typecheck` clean (gateway).
- [ ] `cd ui && npm run build` clean.
- [ ] `npm test` passes all suites.
- [ ] `python3 ~/.claude/skills/decompose-prd/scripts/validate.py --in=prd.json` clean (when prd.json changed).

---

## Watch-list — known regression hotspots
- **W1 · Terminal reattach crash (OPEN BUG):** `attachTerminal` does a plain `INSERT` into `terminal_session`, so a reused `tid` (reattach, or a leftover row from a prior browser-verify run) throws `UNIQUE constraint failed: terminal_session.id` and **crashes the gateway** on terminal connect. Workaround for QA: `DELETE FROM terminal_session;` before a run. Fix = `INSERT OR REPLACE` at [src/terminal/index.ts](../src/terminal/index.ts).
- **W2 · Stale sidecar:** after any `src/**` (gateway) change, the built `.app`/`.dmg` and `tauri dev` run a STALE bundled gateway until `npm run build:sidecar`. Symptom: new routes 404, new tabs empty. Always rebuild the sidecar before a native QA pass.
- **W3 · Dogfooding pty kill:** `npm run dev` (tsx **watch**) restarts on `src/**` edits and kills ALL ptys; `tsx watch`/HMR/HUD-hide/UI-reload also kill ptys (pre-US-017/018). Don't QA terminal survival under a watching gateway — use `npm start`.
- **W4 · Vite is IPv6:** the dev server binds `[::1]:5173` — use `http://localhost:5173`, not `127.0.0.1` (connection-refused otherwise).
- **W5 · Hook token / data dir:** events 401 if the hook token doesn't honor `CONAN_DATA_DIR`; global hooks fire in other cwds. If Context/Pulse go empty, suspect the data-dir/token path before the UI.
- **W6 · OAuth tokens blocked:** `sk-ant-oat*` can't be used for third-party API calls; the interactive terminal `claude` uses normal CLI login (fine).

## Sign-off
| Date | Branch / change | Pass | Notes |
|------|-----------------|------|-------|
|      |                 |      |       |
