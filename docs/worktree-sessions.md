# Worktree-isolated driven sessions (US-043)

A driven session can run in a **fresh git worktree** so parallel runs against
the same repo don't collide on the working tree. Off by default — when unused,
a session runs in the requested cwd exactly as before.

## Launch

`POST /api/claude/sessions` accepts:

| field          | type            | effect                                                          |
| -------------- | --------------- | --------------------------------------------------------------- |
| `worktree`     | boolean         | Cut a fresh worktree off `cwd`'s repo and run the session there. |
| `worktree_ref` | string          | Base ref the worktree branch is cut from (default `HEAD`).      |
| `add_dir`      | string \| string[] | Extra dirs granted to the agent via `--add-dir <path>`.      |

When `worktree` is set, Conan runs `git worktree add -b conan/<stamp>-<rand>
<repo>/.conan-worktrees/<stamp>-<rand> <base>`, uses that path as the session
cwd, and surfaces `worktree_path` + `worktree_base_ref` on the session row (and
in the start response under `worktree`). A non-git cwd returns **400**.

In the UI (`SessionBar`), the **+ New** form has an *Isolation* checkbox ("Run
in a fresh git worktree") and an optional *Worktree base ref* field; a selected
worktree session shows a path chip (`⎇ …path @ <ref>`).

## Teardown

Worktrees are **not** removed automatically — leaving them lets you inspect or
keep the branch. To clean up, stop the session with teardown:

```
POST /api/claude/sessions/:id/stop   { "remove_worktree": true }
```

This runs `git worktree remove --force <path>` from the main repo and clears the
worktree columns on the row. The UI exposes this as a *Remove on stop* checkbox
that appears only for worktree-isolated sessions. The branch itself is left in
place; delete it with `git branch -D conan/<…>` if you don't need it.
