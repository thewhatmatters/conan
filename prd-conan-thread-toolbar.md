# Conan — Thread Toolbar PRD

> A top toolbar above the chat transcript (t3-code's BranchToolbar idea) housing
> the chat title, an editor "Open in", git Commit/Push/Create-PR, and
> user-definable per-project custom actions.
>
> *2026-07-23. Scoped from docs/t3-port-backlog.md (T3-18 + T3-13 + T3-14) for a
> Codex build loop.*

## Problem

Conan's chat surface has no per-thread action bar. Everything you'd want to do
*around* a conversation — open the project in your editor, commit/push what the
agent changed, open a PR, run a project script — has no home. t3-code puts these
in a toolbar above the thread; Conan should too.

## Solution

A slim toolbar pinned above the active thread's transcript:

- **Chat title** (left) — the thread's title, from the existing `chat_thread`
  metadata (display-only for v1; inline rename is later).
- **Open in** — a dropdown of detected editors (VS Code / Cursor / Zed /
  JetBrains) + "Reveal in Finder", opening the thread's project cwd. Preferred
  editor persists.
- **Git actions** — branch + dirty indicator, then Commit (message dialog),
  Push, and Create PR. Commit/Push shell `git`; PR shells `gh pr create`.
- **Custom actions** — per-project runnable scripts (name + command), shown as
  buttons; a `+` adds one; clicking runs it and shows output in a modal.

## Technical architecture

Backend (gateway), all token-gated + CORS-reflected like existing routes:
- `GET /api/editor/detect` (probe `code`/`cursor`/`zed`/`idea`/`subl` on PATH +
  always offer Finder) · `POST /api/editor/open {path, editor?}` (launch via the
  editor CLI, else `open -a`; Finder via `open`/`open -R`).
- `POST /api/agent/git/commit {cwd, message}` · `POST /api/agent/git/push {cwd}`
  — shell `git`; reuse `GET /api/fs/git` for status; surface git stderr honestly.
- `POST /api/agent/git/pr {cwd, title, body}` — shell `gh pr create`; degrade
  with a clear message when `gh` is missing/unauthed or the remote isn't GitHub.
- Custom actions: a `project_action` table (`id, project_id, name, command,
  created_at`) + `GET/POST/DELETE /api/agent/projects/:id/actions` and
  `POST /api/agent/actions/:actionId/run` (run in the project cwd, capture
  stdout/stderr/exit).

Frontend: a `ThreadToolbar.tsx` rendered above the transcript in `ChatPane.tsx`,
h-9, semantic tokens. Controls reuse shadcn dropdown/dialog primitives.

## Scope (v1) — deliberately bounded

IN: GitHub via `gh`, macOS editor launch, commit-message dialog, custom-action
output in a modal. OUT (later): multi-provider source control (GitLab/Bitbucket/
Azure), agent-generated commit messages, inline title rename, streaming action
output to a terminal panel, run-on-worktree-create.

## Risks

- **`gh`/git shelling** — env/auth varies; every route must degrade honestly
  (disabled control + reason), never hang or fake success.
- **Custom-action command execution** is arbitrary shell in the project cwd —
  it's the user's own machine + their own action, but treat output as untrusted
  text (no injection into other shells).
- Toolbar adds permanent chrome above every thread — keep it h-9 and quiet.

## Open questions

- Commit scope: `git add -A` vs staged-only? (v1 assumes add-all with the
  message dialog; revisit if noisy.)
- Where does custom-action output live long-term — modal (v1) vs a reusable
  output drawer?
