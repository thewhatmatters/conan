# v2 checkpoint — 2026-07-31 (p2b transcript + p2d shell + US-604 approval)

Handoff point for picking this branch up on another machine. Written after
committing the day's work; accurate as of `db51c97` on `loop/conan-v2-astryx`.

## Where the branch is

| | |
|---|---|
| Branch | `loop/conan-v2-astryx` |
| Tip | `db51c97` — docs(backlog): queue Edit/Write approval diff disclosure |
| Code commit | `af23281` — feat(v2): rich transcript, live thread status, and the approval card |
| Prior tip | `28f0317` — chore: pin Node to 22.14.0 |

Working tree is clean apart from two untracked files that predate this work —
see [Do not `git add -A`](#do-not-git-add--a).

## Gate results

Run at `af23281`'s tree under Node 22.14.0, all five gates in one pass:

| Gate | Result |
|---|---|
| `cd ui && npm run test` | 126/126 across 20 files |
| `cd ui && npm run typecheck` | clean |
| `cd ui && npm run build` | clean, 2.81s |
| `npm run typecheck` (root) | clean |
| `npm test` (root) | 206/206 |

These numbers describe the tree as a whole. No intermediate state inside
`af23281` was gated on its own.

## What is verified live, and what is not

**US-604 (approval card) — behavioural AC passes.** Proven on a throwaway
`:3799/:5199` stack against an isolated `CONAN_DATA_DIR` and a fresh fixture
repo, across three real Claude sessions:

- Plan mode selectable before the first prompt; a real `ExitPlanMode` request
  arrives ~36s after send.
- The card replaces the composer while blocked (`[contenteditable]` count
  drops to 0) and the composer is restored 0.0s after the decision.
- Plan-specific copy, and no `Always allow this session` on the plan card.
- Approving continues the **same turn** into build.
- The transcript's `ExitPlanMode` row flips from a spinner to a check; a
  decline writes the literal `Approval decline` into the row.
- The non-plan card was exercised on real traffic too — a genuine `Edit`
  request, declined, with the queue advancing to the next request rather than
  stranding the turn.
- Zero `pageerror` across all three runs.

**US-502 / US-503 (thread status, breadcrumb, kebab, new-chat) — code landed,
not independently verified.** Their `passes` flags in
`prd-v2-p2d-shell-live.json` are deliberately still `false`. Do not flip them
without a live pass; jsdom does not lay out or paint (see
`docs/v2-testing-guide.md`).

## Open defects

1. **The plan card points at a plan it does not render.** Copy says "Review
   the plan above", but `V2ApprovalPanel.tsx:77` suppresses `detail` when
   `isPlan`, so the plan markdown is only reachable by expanding a collapsed
   6-call tool group and reading escaped JSON. The markdown is already in
   `approval.detail` — this is a render, not a plumbing job. **Owner: Booker.
   Not landed.**
2. **The approval panel has no `aria-live` and takes no focus.** It has
   `role="region"` + `aria-label` only, so a screen-reader user gets no
   announcement that the turn is blocked. Sighted keyboard users are fine —
   focus falls to body and one Tab reaches "Proceed in build". Rides along
   with defect 1.
3. **Edit/Write approvals show the path, never the change.** Backlogged at the
   top of `docs/ui-improvements-backlog.md` with the full analysis and a
   corrected size (M, not L). Four product decisions are open against it.
   Queued after p2d.
4. **The shell does not collapse its 274px sidebar at narrow width**, leaving
   a ~206px chat column at 480px. The approval panel itself is fine at that
   width. Belongs with US-506, alongside the `SecondaryBar` `aria-expanded`
   fix.

## Still owed

- A p2b PRD file. Every other phase has one (`prd-v2-p2a-chat-core.json`,
  `prd-v2-p2c-*.json`, `prd-v2-p2d-shell-live.json`); p2b and US-604 exist
  only in commit messages and this doc.
- `docs/agent-race-leaderboard.md` has not been updated for this round.
- The custom rename dialog. `App.v2.tsx` currently calls `window.prompt` as an
  explicit placeholder. This is a design task, not an implementation one.

## Environment notes for the next machine

**Node ABI.** Two runtimes touch this repo and `better-sqlite3` is native, so
`node_modules` can only be built for one at a time. The repo pins 22.14.0 via
`.nvmrc` + `engines` (`28f0317`). A mismatch surfaces as `ERR_DLOPEN_FAILED`
in `src/agent/threads.test.ts`, which reads as a code defect and is not one.
Run `nvm use` in the repo root before any gate.

**Raising a real approval for QA.** `src/agent/claude.ts` pushes
`--allow-dangerously-skip-permissions` on every launch (~:471), so an ordinary
unallowlisted Bash call will not prompt in v1 or v2. A **plan-mode session** is
the reliable path — `ExitPlanMode` raises `can_use_tool` by design
(`claude.ts:56-60`). That is what `PermissionModeChip` exists to make
reachable from v2.

**QA stacks.** Persistent launchd agents `so.whatmatters.conan-qa-{gateway,ui}`
are installed on the primary Mac at `:3747`/`:5173` against the **real**
`.data/conan.db`. They have `RunAtLoad`. While they hold `:3747` the packaged
`Conan.app` cannot bind its own gateway. They are not part of this branch and
do not travel with it.

## Do not `git add -A`

Two untracked files sit in this tree. Neither belongs to this work — both date
from 2026-07-26 and the `loop/conan-image-ui` session:

- `docs/pin-probe.txt` — 44 bytes, contains a **credential-shaped string**.
- `ui-audit-2026-07-25.md` — root-level audit scratch.

Both commits above were staged file-by-file to keep them out. Until their
disposition is decided (delete / gitignore / keep), stage explicitly rather
than with `-A`.
