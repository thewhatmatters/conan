# Conan Branch Picker — worktree-backed branch selection at thread creation

> Pick the git branch a chat thread works on — each non-default branch gets its
> own git worktree, so threads on different branches run concurrently without
> yanking the shared checkout.
>
> *Generated 2026-07-26 by generate-prd from in-session discussion.*

## Problem

When starting a new project in Conan there is no way to hand-pick the branch
to work on. Selecting a folder (e.g. the Conan repo itself) silently binds
every thread to whatever branch that checkout happens to be on. T3 — the
parity reference for the Surfaces round — has a branch picker; Conan doesn't.

The deeper issue is that the project folder is a **shared checkout**: other
threads on the same project, the user's own editor, and (in the Conan-on-Conan
case) up to three agents all share it. There is currently no way to point one
thread at branch A and another at branch B without externally re-checking-out
the folder under everyone's feet.

## Solution

A **branch picker in the new-thread flow** (not the project picker), built on
git worktrees — the T3 model:

- Mental model: **project = repo, thread = branch.**
- The picker defaults to the checkout's current branch. Choosing it keeps
  today's behaviour exactly: the thread's `cwd` is the project folder itself —
  no worktree is created.
- Choosing any **other** branch runs `git worktree add` under a Conan-managed
  location (e.g. `~/.conan/worktrees/<repo>--<branch>`, exact location an open
  question) and sets that thread's `cwd` to the worktree path.
- A **"new branch from …"** option creates a branch and its worktree in one
  step (base branch default is an open question — likely main).
- Repeat picks of the same branch **reuse** the existing worktree rather than
  creating a duplicate.

Because every downstream surface — Files, Diff, Terminal, the composer's
branch display — already keys off the thread's `cwd`, they inherit the
worktree for free with no per-surface work.

**Rejected alternative (decided in discussion):** a picker that runs
`git checkout` in place. Simple, but it retargets the shared checkout for
every other thread and the user's editor — a footgun, not a feature.

## UX flow

1. User clicks **New chat** on a project whose folder is a git repo.
2. The composer context row (which already shows the current branch) becomes a
   **branch picker**: current branch preselected, other local branches listed,
   plus "new branch from …".
3. Non-repo project folders show no picker — behaviour unchanged.
4. User picks a branch and sends the first prompt. Since draft threads create
   no DB row until first send, the worktree is created **at first send**, not
   at picker time *(inferred from the draft-thread design — see open
   questions)*.
5. The thread now runs in the worktree; Files/Diff/Terminal surfaces and the
   branch display all reflect it.
6. Fresh worktrees have no `node_modules` — the UI shows an **honest hint**
   (e.g. on the Terminal surface or first tool failure) rather than magically
   auto-installing in v1.

## Technical architecture

Grounded in the current code:

- `chat_thread.cwd` is already **per-thread** (`src/db/schema.sql` — "launch
  cwd (the project path at creation)"). A worktree-backed thread is just a
  thread whose `cwd` is the worktree path; drivers, history reconstruction,
  and surfaces need no changes.
- A **branch + dirty endpoint already exists** (`src/gateway/index.ts:347`,
  US-011) powering the composer's branch display — the picker's "current
  branch" read reuses it.

New gateway surface (shape inferred — to be finalized in decomposition):

```
GET  /api/fs/branches?cwd=…     → { repo, current, branches[] }   (local branches)
POST /api/agent/worktrees       → { cwd } ⇐ { repo, branch, createBranch?, base? }
                                  creates-or-reuses the worktree, returns its path
GET  /api/agent/worktrees?repo= → list Conan-managed worktrees (for lifecycle UI)
DELETE /api/agent/worktrees/…   → prune one (behaviour per open questions)
```

All new endpoints follow the standing gateway conventions: CORS reflector +
WS Origin allowlist, loopback-only, token auth.

## Data model

Minimal-change position *(inferred — not explicitly discussed)*: no new
tables. The worktree path lives in the existing `chat_thread.cwd`; the branch
is derivable from the worktree via the existing branch endpoint. If lifecycle
UI needs to distinguish "Conan-managed worktree" from "user folder", the
worktree storage directory itself is the marker.

## Pricing

(not discussed — see open questions; note the paywall is currently off
globally, so v1 ships ungated by default.)

## Roadmap

Phased as a 4–6 story loop round (per discussion):

- **v1 (this round):**
  1. Gateway: branch list + worktree create/reuse endpoints (+ tests).
  2. UI: branch picker in the new-thread/draft composer flow.
  3. Worktree lifecycle: list + prune, and the abandoned-worktree policy.
  4. QA: surfaces (Files/Diff/Terminal) verified against a worktree thread;
     `node_modules` hint.
- **Later:** auto-install option for fresh worktrees; branch switch on an
  existing thread; PR-aware flows (branch → PR status in the thread toolbar).

## Risks

- **Worktree lifecycle leaks** — abandoned worktrees accumulating disk and
  confusing `git worktree list`; pruning policy must be explicit.
- **Fresh-worktree missing deps** — threads that immediately run tests or dev
  servers fail without `node_modules`; v1 mitigates with an honest hint only.
- **Same-branch collision** — git forbids two worktrees on one branch; the
  reuse rule must handle "branch already checked out in the main folder"
  (picker should treat that as "use the project folder").
- **Non-repo and detached-HEAD folders** — picker must degrade honestly
  (hidden / disabled), never block thread creation.

## Ratified decisions (2026-07-26, Randy)

- **Storage:** `~/.conan/worktrees/` — global, outside every repo.
- **Prune:** auto on thread delete — deleting the last thread on a branch
  removes its worktree **only if clean** (dirty worktrees survive with a
  note); `git worktree prune` on gateway boot.
- **New-branch base:** the repo's default branch (main).
- **Creation timing:** at first send — aligns with draft threads (no DB row,
  no worktree, zero residue for abandoned drafts).

## Open questions

- Thread reopen when its worktree was deleted externally: recreate silently,
  or banner + degrade like the missing-history case?
- Pricing/gating: none discussed; revisit with the broader Premium re-enable
  decision.
