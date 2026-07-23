# Conan — HANDOFF (agent-agnostic)

_Updated 2026-07-23. Read this first. Then `CLAUDE.md` for stack/conventions/
gotchas. This doc is written to be read by ANY coding agent (Claude, Codex, …)
picking up the Conan build._

## What Conan is NOW

A **chat-primary desktop cockpit for driving Claude Code** (Tauri v2 + React +
a loopback Node gateway sidecar). It drives `claude` **headlessly** (`claude -p`
stream-json over a `/ws/agent` WebSocket) behind a custom chat UI:

- **Project-grouped thread sidebar** (first-class projects with a folder path;
  threads nested inside; persisted in SQLite, survive reload + gateway restart).
- **Streaming transcript** — token-by-token text, collapsed reasoning*, tool
  cards with inline diffs, plan cards, per-turn cost footer.
- **Interactive tool-approval** (Supervised default: Approve once / Always allow
  / Decline / Cancel), live-switchable permission mode.
- **Activity spine** — a thin rail fusing prompt/skill/tool ticks (hover-preview,
  click-to-jump). Conan's differentiator vs t3-code (which has no timeline/cost).
- **Sigil composer** — model + permission chips + `@` files/folders · `$` skills
  · `/` commands autocomplete.

The terminal (`xterm.js`) surface and the DevTools HUD were **removed from the
mounted UI**; that code is dormant in the repo. See `CLAUDE.md` for the current
chat architecture + the dormant subsystems.

\* reasoning is plumbed but DORMANT — see the D2 note under "Known limits".

## Current state (branch / git)

- **Branch: `loop/conan-chat-v1`** (git). `main` is clean at `f23bc7c` — the
  chat rebuild is NOT merged yet.
- **`prd.json` branchName label:** rotates per loop (`loop/conan-chat-v1` for the
  25-story chat-v1 build, `loop/conan-chat-v1-polish` for the polish loop).
- **chat-v1: DONE** — 25 stories, archived at
  `archive/2026-07-23-conan-chat-v1-complete/`.
- **Polish loop: in progress** at time of writing — check `prd.json` `passes`
  flags for live status (6 stories: permission-unlock, auto-open, settings
  entry, skill ticks, sort/group menu, command-palette picker).
- **QA:** the whole build was walked A–G; findings + status live in
  `docs/chat-v1-qa-backlog.md` (the running backlog / task source).

## What's next (the roadmap, ordered)

1. **QA the polish loop** — dogfood the 6 polish stories; log findings to
   `docs/chat-v1-qa-backlog.md`.
2. **PD-1** — richer thread rows (title + description + status icon/badge). Spec
   in the backlog. Needs a `last_message` preview data source.
3. **t3 feature ports** — see `docs/t3-port-backlog.md` (the wishlist). This is
   the main "keep building" track; not yet decomposed into stories.
4. **Ship-gates (before any release / merge to `main`):**
   - **H1 — native build unverified.** EVERYTHING so far ran only in a browser
     dev stack. **No Rust toolchain is installed** on this machine, so
     `tauri-plugin-dialog` (added in the cwd picker) has never compiled. Install
     Rust (`rustup default stable`), `npm run build:sidecar`, then
     `CI=true npm run tauri:build`. Do this BEFORE investing more — a broken
     native build blocks everything.
   - **H4 — Premium is hollow.** Conan is a shipped $29 product; the Premium-
     gated surfaces (Timeline insight, Pulse, etc.) were DELETED with the HUD.
     Decide what Premium means in a chat-primary Conan (candidates: gate the
     activity spine / thread history / future multi-provider — or drop the
     paywall). **Product decision — a human must make it.**
   - **Full CLAUDE.md rewrite** — the top is corrected + a chat-architecture
     section added, but the long "## Architecture (DORMANT…)" body still
     documents the terminal era. A line-by-line rewrite is a clean-up task.
   - **Dead-code decision** — delete or keep dormant: `TerminalPane`/`Terminal`,
     `Hud`/`Widgets`/`Timeline`/`*Widget`/`PulseChart`, `RadioBar`, `StatusBar`,
     `src/terminal/*`, `correlate.ts`, `terminal_session`, orphaned routes.
   - **Merge `loop/conan-chat-v1` → `main`** — 20+ commits replacing the primary
     surface; needs a real review pass.
5. **Release** — version bump + `npm run release` (sign/notarize/staple) +
   `gh release create` + announce (see `.claude/skills/release-conan/` and the
   `announce-conan-release` skill).

## How to run + QA (dev)

Do NOT rely on the native app (won't build yet — H1). Use the browser dev stack:

```bash
# gateway — npm start (NO watch; npm run dev's tsx-watch restarts on src edits)
npm start                       # gateway on :3747
cd ui && npm run dev            # vite on :5173  (open http://localhost:5173)
```
- **Gateway routes verify:** `curl -s localhost:3747/api/health`.
- **Browser QA:** use the `automate-browser` skill (Playwright) to drive
  `http://localhost:5173`, screenshot, and interact. Dismiss any first-run
  overlays. Force dark via `localStorage.setItem('conan-theme-id','dark')`.
- **Per-story browser verification** uses a **throwaway port stack** so it never
  touches the dev :3747 — e.g. `CONAN_PORT=3799 CONAN_DATA_DIR=/tmp/x npm start`
  + `CONAN_PORT=3799 CONAN_UI_PORT=5199 npm run dev`, with
  `CONAN_ALLOWED_ORIGINS=http://localhost:5199` so the WS upgrade passes.
- **Gates before commit:** `npm run typecheck` (gateway) + `cd ui && npm run
  build`, both clean. `npm test` for the suite.

## Footguns (learned the hard way)

- **Vite (:5173) drops silently.** After ANY gateway restart, verify BOTH ports
  (`curl` :3747 AND :5173) — the gateway coming back doesn't mean vite is up.
  A stale `ui/node_modules/.vite` cache also white-screens the page; `rm -rf` it
  and restart vite.
- **Dogfooding:** editing `src/gateway/*` or `src/terminal/*` under `npm run dev`
  (tsx-watch) restarts the gateway and kills ptys. Use `npm start`.
- **`t3code/` is gitignored** — it's the reference t3-code source (an embedded
  repo). Never commit it.
- **D2 / reasoning is a platform limit**, not a bug: headless `claude -p`
  redacts thinking TEXT (empty string + signature only), verified across
  fable-5/opus/sonnet. The reasoning UI is left dormant.
- **Subscription auth only** — the headless path uses the user's Claude login;
  never introduce `ANTHROPIC_API_KEY` (`sk-ant-oat*` is blocked for API calls).

## The autonomous build loop (provider-agnostic)

`run-tasks.sh` loops a fresh agent over `prd.json` until every story `passes`.
It is **provider-agnostic** via `AGENT_CMD`:

```bash
# Claude (default):
AGENT_CMD="claude -p --permission-mode bypassPermissions" ./run-tasks.sh
# Failover to another agent (e.g. Codex) — same prd.json contract:
AGENT_CMD="codex exec" ./run-tasks.sh
```
Run it **detached** (`nohup … & disown`) so a session exit can't kill it;
`bypassPermissions`/equivalent so it doesn't stall on tool prompts. Each story
commits on pass. `prd.json` + `progress.txt` are the source of truth.

**To decompose a backlog into a new `prd.json`:** use the `decompose-prd` skill
(or hand-author to the schema in `archive/…/prd.json`). Archive the completed
`prd.json` first.

## Picking up as a different agent (e.g. Codex)

1. Read `AGENTS.md` → `CLAUDE.md` → this file.
2. Live task list: `docs/chat-v1-qa-backlog.md` (PD-1 + QA items) and
   `docs/t3-port-backlog.md` (feature wishlist).
3. For a defined story set, drive `run-tasks.sh` with your own `AGENT_CMD`.
4. Respect the footguns above — especially the dev-stack + auth ones.
