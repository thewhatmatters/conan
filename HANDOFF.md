# Conan — HANDOFF (agent-agnostic)

_Updated 2026-07-24. Read this first. Then `CLAUDE.md` for stack/conventions/
gotchas. This doc is written to be read by ANY coding agent (Claude, Codex, …)
picking up the Conan build._

## What Conan is NOW

A **chat-primary, multi-provider desktop cockpit for coding agents** (Tauri v2
+ React + a loopback Node gateway sidecar). It drives **Claude Code, Codex, and
Grok headlessly** (stream-json/JSONL child processes normalized through the
`AgentDriver` seam, over a `/ws/agent` WebSocket) behind a custom chat UI:

- **Project-grouped thread sidebar** (first-class projects with a folder path;
  threads nested inside; persisted in SQLite, survive reload + gateway restart;
  per-thread C/X/G avatar = the provider that drove it).
- **Streaming transcript** — capability-driven: token deltas or an honest
  Working indicator, collapsed reasoning (real for Grok*), tool cards with
  inline diffs, plan cards, per-turn $-or-token footer.
- **Interactive tool-approval** (Claude only — Codex/Grok have no headless
  approval channel; the UI hides it via capabilities), permission chip in each
  provider's own vocabulary (Claude modes / Codex sandbox levels).
- **Activity spine** — a thin rail fusing prompt/skill/tool ticks (hover-preview,
  click-to-jump). Conan's differentiator vs t3-code (which has no timeline/cost).
- **Sigil composer** — provider chip (locks after turn 1) + model + permission
  chips + `@` files/folders · `$` skills · `/` commands autocomplete.

The terminal (`xterm.js`) surface and the DevTools HUD were **removed from the
mounted UI**; that code is dormant in the repo. See `CLAUDE.md` for the current
chat architecture + the dormant subsystems.

\* reasoning TEXT is real for Grok; for headless Claude it's redacted (D2, see
"Known limits") so the Thinking UI stays hidden there.

## Current state (branch / git)

- **Branch: `loop/conan-multi-provider`** (on top of `loop/conan-chat-v1`),
  **pushed to `origin` and tracking**. `main` is clean at `f23bc7c` — nothing
  chat-era is merged yet.
- **chat-v1: DONE** — 25 stories, archived at
  `archive/2026-07-23-conan-chat-v1-complete/`. **Polish loop: DONE** (6
  stories). **PD-1 richer thread rows: DONE.**
- **T3-1 multi-provider: DONE (2026-07-23, this branch, 12 stories)** —
  `AgentCapabilities` on the driver seam; provider registry + login-shell
  install probe (`GET /api/agent/providers`); `CodexDriver` (one process per
  turn, `codex exec --json`, sandbox permission mapping) + `GrokDriver`
  (deltas, real reasoning text, `total_cost_usd`); `chat_thread.provider`
  column + resume routed to the thread's OWN provider; WS launch frame carries
  provider + capabilities pushed at session start; capability-driven composer
  chip / permission chip / transcript / sidebar avatars. **Read
  `docs/multi-provider-qa.md`** for the honest per-provider matrix — now fully
  green: the two reopen gaps the loop shipped with were fixed 2026-07-24 (see
  below).
- **Reopen parity across all three providers: DONE (2026-07-24).**
  - The grok exit-1 blocker is fixed. Root cause was conflating a *reported*
    model (telemetry) with a *launch* model (user intent): grok reports
    `grok-4.5-build`, which `-m` rejects. New capability
    `AgentCapabilities.modelSelection` (claude true, codex/grok false) gates
    whether a reported model is persisted, so no provider can poison a thread
    this way. The thread upsert `COALESCE`s model — a null write keeps the old
    value — so an idempotent migration in `src/db/index.ts` also clears
    already-saved values for non-claude threads.
  - Transcript readers now exist per provider: `src/agent/codexHistory.ts`
    (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`) and
    `src/agent/grokHistory.ts`
    (`$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<session_id>/chat_history.jsonl`).
    Both CLIs append resumed turns to the SAME file, so one file is the whole
    conversation. The transcript route dispatches by the thread's provider.
    Because history is FOUND again, ChatPane keeps the resume id — so reopened
    codex/grok threads continue the REAL conversation, verified by having each
    agent quote a question asked before the reopen.
- **QA:** chat-v1 findings live in `docs/chat-v1-qa-backlog.md`; the polish
  loop's 6 stories are still not QA-dogfooded; multi-provider QA is
  `docs/multi-provider-qa.md`.

## What's next (the roadmap, ordered)

1. **QA the polish loop** — dogfood the 6 polish stories (US-001..006); log
   findings to `docs/chat-v1-qa-backlog.md`. The oldest unpaid QA debt.
2. **t3 feature ports** — see `docs/t3-port-backlog.md`. T3-1 is DONE; **T3-19
   provider maintenance UI** is the natural follow-on (registry + probe exist).
3. **Ship-gates (before any release / merge to `main`):**
   - ✅ **H1 — native build VERIFIED (2026-07-24).** Was blocked because
     `~/.cargo/bin` held rustup *shims with no default toolchain* — `cargo`
     resolving on PATH did NOT mean Rust worked. After `rustup default stable`
     (1.97.1): `npm run build:sidecar` clean, then `CI=true npm run tauri:build`
     compiled in ~43s and bundled `Conan.app` (139M) + `Conan_1.4.0_aarch64.dmg`
     (45M) — including `tauri-plugin-dialog`, which had never been built. The
     packaged app launches, its bundled `runtime/node` serves `gateway.cjs`, and
     **`GET /api/agent/providers` detects all three providers inside the .app**
     (the login-shell PATH probe survives bundling — the packaged-PATH gotcha
     is handled). Caveat: a plain `tauri:build` exits 1 at the very end on
     `TAURI_SIGNING_PRIVATE_KEY` — that's updater-artifact signing, not a
     compile failure; `npm run release` supplies the key. The native window's UI
     was NOT visually verified (macOS screen-recording permission blocks
     terminal screenshots).
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
   - **Merge `loop/conan-multi-provider` (contains `loop/conan-chat-v1`) →
     `main`** — 30+ commits replacing the primary surface; needs a real review
     pass. (The grok reopen bug that used to block this is fixed.)
4. **Release** — version bump + `npm run release` (sign/notarize/staple) +
   `gh release create` + announce (see `.claude/skills/release-conan/` and the
   `announce-conan-release` skill).

## How to run + QA (dev)

The native app now builds and runs (H1 verified 2026-07-24), but the browser
dev stack is still the fast loop for QA:

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
- **`cargo` on PATH does NOT mean Rust works.** `~/.cargo/bin/*` are rustup
  SHIMS; with no default toolchain every invocation fails with "rustup could
  not choose a version of rustc to run". Check `rustc --version`, not `which
  rustc`. Fix: `rustup default stable`.
- **`t3code/` is gitignored** — it's the reference t3-code source (an embedded
  repo). Never commit it.
- **D2 / Claude reasoning is a platform limit**, not a bug: headless
  `claude -p` redacts thinking TEXT (empty string + signature only), verified
  across fable-5/opus/sonnet. The Thinking UI is capability-gated
  (`reasoningText`): live for Grok, hidden for Claude.
- **Subscription auth only** — the headless Claude path uses the user's Claude
  login; never introduce `ANTHROPIC_API_KEY` (`sk-ant-oat*` is blocked for API
  calls). Codex/Grok likewise ride their own CLI logins.
- **Codex reads stdin when piped** — `codex exec` must get the prompt as argv
  with `stdin:'ignore'` (the driver does this; the "Reading additional input
  from stdin..." stderr line is benign noise).

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
