# AGENTS.md — Conan

Instructions for any coding agent (Codex, etc.) working in this repo. Claude
Code reads `CLAUDE.md`; this file mirrors the essentials for other agents.

## Read these first, in order
1. **`HANDOFF.md`** — live state: what Conan is now, what's done, what's next,
   how to run/QA. START HERE.
2. **`CLAUDE.md`** — stack, conventions, gotchas. Its top block flags that Conan
   is now **chat-primary** (the long "Architecture (DORMANT…)" body describes the
   removed terminal/HUD era — history only).
3. Task lists: `docs/chat-v1-qa-backlog.md` (QA findings + PD-1) and
   `docs/t3-port-backlog.md` (feature wishlist).

## The one-line orientation
Conan is a **chat-primary desktop app that drives Claude Code headlessly**
(`claude -p` stream-json over a `/ws/agent` WebSocket) behind a custom React
chat UI. Branch `loop/conan-chat-v1` (NOT merged to `main`). The terminal/HUD
surfaces are removed from the UI but still in the repo (dormant).

## Non-negotiable rules
- **Every change:** `npm run typecheck` (gateway) AND `cd ui && npm run build`
  must pass before commit. `npm test` for the suite.
- **Run the gateway with `npm start`, not `npm run dev`** (tsx-watch restarts on
  src edits). UI: `cd ui && npm run dev` → http://localhost:5173.
- **After restarting the gateway, verify BOTH :3747 and :5173** — vite drops
  silently; the gateway being up does not mean the UI is.
- **Subscription auth only.** The headless path uses the user's Claude login;
  NEVER add `ANTHROPIC_API_KEY` (`sk-ant-oat*` tokens are blocked for API calls).
- **Semantic theme tokens only** in UI (`bg-background`, `text-foreground`,
  `border-border`, …) — no hard-coded hex/neutral-*. shadcn primitives in
  `ui/src/components/ui/*`. Light default; dark via `.dark`.
- **Never commit `t3code/`** (gitignored reference source).
- **Verify UI changes in a real browser** (Playwright / the `automate-browser`
  skill) — screenshots + interaction, not just a build.

## The build loop
`run-tasks.sh` runs a fresh agent over `prd.json` until all stories `passes`.
Provider-agnostic via `AGENT_CMD` (e.g. `AGENT_CMD="codex exec" ./run-tasks.sh`).
Run detached; each story commits on pass. See `HANDOFF.md` for details.
