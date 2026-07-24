# AGENTS.md — Conan

Instructions for any coding agent (Codex, etc.) working in this repo. Claude
Code reads `CLAUDE.md`; this file mirrors the essentials for other agents.

## Read these first, in order
1. **`CLAUDE.md`** — architecture, stack, conventions, gotchas, and the chat
   dev-stack run/QA workflow. START HERE. Its top block flags that Conan is
   **chat-primary** (the long "Architecture (DORMANT…)" body describes the
   removed terminal/HUD era — history only). `HANDOFF.md` is retired; live
   working state lives in Claude's project memory (checkpoint entry).
2. **`prd.json`** — the round currently being built. Its `description` carries
   the run/QA rules inline, and every story's `acceptanceCriteria` are the
   contract. The matching `prd-*.md` beside it is the source PRD with the
   reasoning and the verified probe results behind each decision.
3. Task lists: `docs/chat-v1-qa-backlog.md` (QA findings + PD-1) and
   `docs/t3-port-backlog.md` (feature wishlist).

**If you are NOT Claude Code:** the checkpoint entry named above lives in
Claude's project memory (`~/.claude/projects/…`), outside this repo — you
cannot read it. Everything you need is in the repo instead: `CLAUDE.md` for
architecture, `prd.json` + its `prd-*.md` for the current round, `docs/` for
backlogs and QA state, and `git log` for what just changed. Treat those as the
source of truth and don't assume there's hidden context you're missing.

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

### ⚠️ Browser-verification stories need a sandbox that can bind ports
Many UI stories require driving the app in a real browser (they say so in their
`acceptanceCriteria`). **A sandboxed agent that cannot bind localhost ports
cannot satisfy those** — this is a real limit hit before, not a hypothetical.
If that's you:

- **Take only the stories you can actually finish** (backend / seam / parser
  work) rather than running the whole loop top-to-bottom. Story `notes` carry
  an `Owner:` hint when a round has been split.
- **Never mark a browser-verification story `passes: true` without doing the
  browser check.** Typecheck + build passing is NOT the same as verified —
  this repo has essentially no UI component tests, so that check is the only
  thing catching rendering bugs. Leave it `false` and say why.
