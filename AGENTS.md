# AGENTS.md — Conan

Instructions for any coding agent (Codex, etc.) working in this repo. Claude
Code reads `CLAUDE.md`; this file mirrors the essentials for other agents.

## Read these first, in order
1. **`CLAUDE.md`** — architecture, stack, conventions, gotchas, and the chat
   dev-stack run/QA workflow. START HERE. Its top block flags that Conan is
   **chat-primary** (the long "Architecture (DORMANT…)" body describes the
   removed terminal/HUD era — history only). `HANDOFF.md` is retired; live
   working state lives in Claude's project memory (checkpoint entry).
2. Task lists: `docs/chat-v1-qa-backlog.md` (QA findings + PD-1) and
   `docs/t3-port-backlog.md` (feature wishlist).

## The one-line orientation
Conan is a **chat-primary desktop app that drives Claude Code, Codex, and Grok
headlessly** (stream-json/JSONL child processes normalized through the
`AgentDriver` seam, over a `/ws/agent` WebSocket) behind a custom React chat
UI. Merged to `main` 2026-07-24. The terminal/HUD surfaces are removed from
the UI but still in the repo (dormant).

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
Run detached; each story commits on pass. Decompose backlogs into a new
`prd.json` with the `decompose-prd` skill (schema example in `archive/`).
