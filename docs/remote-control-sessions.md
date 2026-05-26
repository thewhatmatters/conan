# Remote-control / Chrome driven sessions (US-047)

A driven session can be launched with Claude Code's **Remote Control**
(`--remote-control [name]`) and/or **Chrome integration** (`--chrome`). Both are
opt-in — when unused, a session launches exactly as before. Once launched, the
session is tracked and observed in Conan like any other driven session (events,
tokens, status all flow over `/ws`).

## Launch

`POST /api/claude/sessions` accepts:

| field            | type              | effect                                                                       |
| ---------------- | ----------------- | ---------------------------------------------------------------------------- |
| `remote_control` | boolean \| string | Enable Remote Control. `true` = unnamed; a string passes it as the session name. |
| `chrome`         | boolean           | Enable the Claude-in-Chrome integration (`--chrome`).                        |

These map straight onto the CLI flags:

- `remote_control: true` → `--remote-control`
- `remote_control: "my-bridge"` → `--remote-control my-bridge`
- `chrome: true` → `--chrome`

Omitting a field (or sending `false`) leaves the flag off, so defaults are
unchanged.

## UI

In `SessionBar`, the **+ New** form has an *Enable Remote Control* checkbox plus
an optional *Remote-control name* field, and a *Claude in Chrome* checkbox. The
name field is disabled until Remote Control is enabled; an empty name enables
Remote Control unnamed.
