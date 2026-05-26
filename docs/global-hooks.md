# Multi-project global hooks (US-002)

By default Conan's Claude Code hooks live in **this repo's**
`.claude/settings.json`, so only `claude` runs launched *inside*
`~/Development/conan` self-report to the dashboard. To turn Conan into a
machine-wide observatory — every `claude` run in any repo lighting up the
timeline and widgets — install the same forwarder into the **user-level**
`~/.claude/settings.json`, which Claude Code applies to every session
regardless of working directory.

## Install

```bash
npm run hooks:install-global
# uninstall again:
tsx scripts/install-global-hooks.mjs --remove
```

Or, with the gateway running, hit the token-gated endpoint:

```bash
curl -X POST http://127.0.0.1:3747/api/claude/hooks/install-global \
  -H "x-conan-token: $(cat .data/auth-token)"
# remove: add  -d '{"remove":true}'  (content-type: application/json)
```

Both routes call the same code in `src/hooks/install.ts`.

## What it does (and doesn't)

- **Non-destructive merge.** Your existing user hooks, settings, and any unknown
  top-level keys are preserved. Conan only *appends* its own matcher-group for
  each of the 9 lifecycle events (`SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `PreCompact`,
  `SubagentStop`, `Stop`).
- **Idempotent.** A second run is a no-op — it won't add a duplicate group. The
  installer reports `changed: false`.
- **Backed up.** Before the first write it copies the existing file to
  `~/.claude/settings.json.conan-bak`.
- **Absolute command path.** The global hook runs from arbitrary cwds, so the
  command is `node "<abs>/scripts/hooks/send-event.mjs"` — unlike the in-repo
  hook, which can use the relative `node scripts/hooks/send-event.mjs`.
- **Fire-and-forget.** `send-event.mjs` POSTs with a 1s timeout and always exits
  0, so it never blocks or breaks an agent — even when the gateway is down.

## How the data flows

The forwarder carries the session `cwd` in every event. The gateway
(`POST /api/claude/events`) ingests events from **any** cwd, stores the `cwd` on
the session row, and the timeline query is filterable by it:

```
GET /api/claude/events?cwd=/path/to/some/repo
```

The in-repo project hook keeps working unchanged; the global hook is purely
additive. Conan's Settings view (`readHooksStatus`) already falls back to
`~/.claude/settings.json`, so once installed it reports the global hooks as
wired.

## Auth note

The forwarder reads the gateway token from `CONAN_AUTH_TOKEN` or
`<repo>/.data/auth-token` (resolved relative to the script's own location, so it
works from any cwd). Events are token-gated end to end.
