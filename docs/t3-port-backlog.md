# t3-code → Conan feature-port backlog

Features from t3-code (reference source in `t3code/`, gitignored) worth porting
to Conan's chat surface. Derived from the t3-code interface map (2026-07-22).
Not yet decomposed into stories — this is the wishlist to prioritize, then feed
to `decompose-prd` (or build by hand).

**Status:** wishlist · queued · building · done · skip.
**Size:** S (<half a story) · M (a story) · L (multi-story / new subsystem).

## Already have (Conan's chat-v1 covers these)
- Sigil composer (`@` files/folders, `$` skills, `/` commands), model +
  permission chips, interactive tool-approval, token streaming, tool cards,
  inline diffs, plan cards, thread sidebar + persistence + resume, activity
  spine (Conan-only — t3 has no timeline).

## Port candidates

| ID | Feature (t3-code) | Notes for Conan | Size | Status |
|----|-------------------|-----------------|------|--------|
| T3-1 | **Multi-provider** (Codex / Cursor / OpenCode / Grok) | The `AgentDriver` seam (`src/agent/driver.ts`) already exists for exactly this — add drivers behind it + a provider picker in the composer (locked per-thread after first turn, as t3 does). Conan's marquee expansion; also the credit-failover story. | L | wishlist |
| T3-2 | **Image attachments** | Paste/drop images into the composer (t3 does images-only). Claude supports image content blocks; the driver sends them in the user message. | M | wishlist |
| T3-3 | **@-mention content pinning** | Today `@` inserts a path reference (agent reads it). t3 pins file CONTENT as context. Upgrade `@`/`$` from text-insert to real context pinning. | M | wishlist |
| T3-4 | **Full diff panel / viewer** | t3 routes diffs to a dedicated Diff tab. Conan shows inline diffs in tool cards (no panels). A richer full-screen/side-by-side diff viewer is the port. | M | wishlist |
| T3-5 | **Context-window meter** | t3's circular gauge in the composer. Conan can beat it by also showing COST (t3 shows neither cost nor a timeline). A small composer meter. | S | wishlist |
| T3-6 | **Reasoning-effort / traits controls** | t3's per-provider effort/trait picker (Claude "ultrathink" etc.). Composer control mapping to model params. Note: reasoning TEXT is redacted headless (see HANDOFF D2), but effort still affects behavior. | S | wishlist |
| T3-7 | **Worktree / "environment" isolation** | t3 gives each thread an isolated git worktree + branch, so parallel agents don't collide. Conan uses a shared cwd per project. Real subsystem (create/track/clean worktrees). Was deferred in chat-v1. | L | wishlist |
| T3-8 | **Remote project sources** (Git URL / GitHub / GitLab clone) | t3's "Sources" sheet beyond Local folder. This is the deferred backlog item A1-b — a cloning subsystem with auth + progress. | L | wishlist |
| T3-9 | **Agent free-form questions panel** | t3 has a distinct composer panel for when the agent asks the user a question (separate from tool approval). Conan surfaces these as Notification hooks only. | M | wishlist |
| T3-10 | **Right-panel work surfaces** (Browser / Terminal / Files / Diff) | t3's live observation tabs beside the thread. Conan deliberately cut panels; revisit only if a specific one earns its space (Files/Diff most likely). | L | skip-for-now |
| T3-11 | **Draft-based new-thread flow** | t3 creates a draft that promotes to a real thread on first send (reuses an empty draft per project). Conan creates the thread immediately. Minor UX nicety. | S | wishlist |
| T3-12 | **Remote access** (SSH / Tailscale, `npx t3` web server) | t3 is web-first with remote access. Conan is a local native app — this is a different product direction; likely skip. | L | skip |

## Suggested first slice
If porting: **T3-1 multi-provider** is the highest-leverage (unlocks Codex for
credit failover AND is the biggest differentiator), but it's L. For quick wins
first: **T3-5 context+cost meter (S)**, **T3-11 draft threads (S)**, **T3-6
effort control (S)**, then **T3-2 images (M)** / **T3-3 content pinning (M)**.
