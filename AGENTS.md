# AGENTS.md — Conan

Instructions for any coding agent (Codex, etc.) working in this repo. Claude
Code reads `CLAUDE.md`; this file mirrors the essentials for other agents.

## Read these first, in order
1. **`CLAUDE.md`** — architecture, stack, conventions, gotchas, and the chat
   dev-stack run/QA workflow. START HERE. Its top block flags that Conan is
   **chat-primary** (the long "Architecture (DORMANT…)" body describes the
   removed terminal/HUD era — history only). `HANDOFF.md` is retired; live
   working state lives in Claude's project memory (checkpoint entry).
2. **`WORKFLOW.md`** — how the team (Randy, Hermes, Booker, Nash, Barkley) moves
   a ticket from assignment to promotion. Read this before any ticket work.
3. **Linear** — the task source of truth. Tickets are `WHA-…`; the agent MCP
   cannot reach the workspace, so Hermes syncs status and quotes the acceptance
   criteria into the channel. The remaining `prd-v2-*.json` files are the
   source-of-record for their open stories until those tickets ship.
4. Task lists: `docs/t3-port-backlog.md` (feature wishlist; T3-1/5/11/6/3 done),
   `docs/ui-improvements-backlog.md` (deferred UI polish — the next likely
   round: image paste + paperclip rethink, a unified provider/model picker,
   context-window default fix), and `docs/chat-v1-qa-backlog.md` (older QA).

**Round status (2026-07-24):** three stacked feature branches, none merged to
`main` yet (each builds on the prior):
1. `loop/conan-daily-driver` — context meter, draft threads, effort chip,
   @-pins. DONE 11/11. `docs/daily-driver-qa.md`.
2. `loop/conan-image-backend` — Codex round: context-window fix + image-input
   backend seam (imageInput capability, staging, per-provider driver plumbing).
   DONE 7/7. `docs/provider-image-input.md`.
3. `loop/conan-image-ui` (current) — provider brand-icon avatars + image PASTE
   (browser → base64 → staging → transcript). DONE + verified (Claude read a
   pasted image). Remaining UI round work: the unified provider/model picker and
   retiring the paperclip (fold pinning into `@`) — see
   `docs/ui-improvements-backlog.md`.

Merge order when collapsing to main: daily-driver → image-backend → image-ui.
The Codex/Claude split keeps working: Codex takes seam/driver/parser stories
(no browser); Claude takes UI stories (need a port-binding sandbox for
automate-browser). Owner hints live in each story's `notes`.

**If you are NOT Claude Code:** the checkpoint entry named above lives in
Claude's project memory (`~/.claude/projects/…`), outside this repo — you
cannot read it. Everything you need is in the repo instead: `CLAUDE.md` for
architecture, `WORKFLOW.md` for the ticket lifecycle, `docs/` for backlogs and
QA state, and `git log` for what just changed. Treat those as the
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
- **To restart the gateway, `pkill -f "gateway/index.ts"` — NOT
  `pkill -f "tsx src/gateway"`** (the process is `node …/tsx …/gateway/index.ts`,
  so the tsx pattern matches nothing). If the old one survives, the port stays
  bound and the new `npm start` exits on "port bound" while a STALE gateway
  keeps serving — silently, so new routes 404 and code changes don't apply. And
  do NOT `lsof -ti:3747 | xargs kill` — vite holds a proxy connection to 3747
  and gets killed too. Cost real time; verify the served process's start time.
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
