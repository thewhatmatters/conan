# Provider fixtures — verified headless behavior (US-001)

Real NDJSON event streams captured 2026-07-23 from live runs in `/tmp/conan-probe`
(never the conan repo). These are the source of truth for the Codex/Grok drivers
and their parser tests — build against these, not `--help` guesses.

Probed versions: `codex-cli 0.144.6` · `grok 0.2.111` · both installed at
`~/.local/bin` (found via an interactive login shell, per the packaged-app PATH
gotcha).

## Fixtures

| File | Command | What it shows |
| --- | --- | --- |
| `codex-turn1.jsonl` | `codex exec --json --skip-git-repo-check -C <cwd> "<prompt>"` | Basic turn: `thread.started` (carries `thread_id`, the resume key) → `turn.started` → `item.completed(agent_message)` → `turn.completed` (token usage) |
| `codex-turn2-resume.jsonl` | `codex exec --json --skip-git-repo-check -C <cwd> resume <thread_id> "<prompt>"` | 2-turn continuity VERIFIED: same `thread_id`, answered "probe-ok" from turn-1 context |
| `codex-turn3-tools.jsonl` | + `--sandbox workspace-write` | Tool events: `item.started`/`item.completed` with `command_execution` (command, aggregated_output, exit_code, status) and `file_change` (changes[{path,kind}], status) |
| `grok-turn1.jsonl` | `grok -p "<prompt>" --output-format streaming-json --cwd <cwd>` | Token deltas: `{type:"thought",data}` (REAL readable reasoning) + `{type:"text",data}` + `{type:"end"}` (sessionId, usage, num_turns, total_cost_usd, modelUsage) |
| `grok-turn2-resume.jsonl` | + `--resume <sessionId>` | 2-turn continuity VERIFIED: same sessionId, answered from turn-1 context |
| `grok-approval-default.jsonl` | + `--permission-mode default`, prompt requires a shell command | Open question (a) ANSWERED: turn ends `stopReason:"Cancelled"` — see below |
| `grok-turn4-filewrite.jsonl` | + `--permission-mode bypassPermissions --resume <sessionId>` | Open question (b) evidence + tool execution verified on disk (file really created); STILL only thought/text/end in the stream |

## Verified capability matrix

| Capability | claude (existing driver) | codex | grok |
| --- | --- | --- | --- |
| Token/streaming deltas | yes | **NO** — whole items only (`item.completed`) | yes (`thought` + `text` deltas) |
| Interactive tool approval | yes (stdio control channel) | **NO** — sandbox policy instead (`--sandbox read-only\|workspace-write\|danger-full-access`); no approval channel in `codex exec` | **NO** — see (a) below |
| Live permission switch (mid-session control channel) | yes (`set_permission_mode`) | **NO** — one process per turn; mode is fixed at spawn | **NO** live channel — but per-turn switch works, see (b) |
| Cost in USD | yes (`total_cost_usd`) | **NO** — token counts only (`turn.completed.usage`: input/cached_input/output/reasoning_output_tokens) | yes (`end.total_cost_usd`, plus per-model `modelUsage`) |
| Readable reasoning text | NO (D2 — headless claude redacts thinking) | NO (reasoning_output_tokens counted, text not streamed) | **YES** (`thought` deltas are real text) |
| Resume | yes (`--resume <session_id>`) | yes (`codex exec … resume <thread_id>`) — VERIFIED | yes (`--resume <sessionId>`) — VERIFIED |
| Process model | one long-lived process per session | **one process per turn** | one process per turn |
| Tool-use visibility in stream | yes (tool_use/tool_result events) | yes (`command_execution` / `file_change` items) | **NONE** — stream is ONLY `thought`/`text`/`end`; tools run invisibly (verified: file created on disk with zero tool events emitted) |

## Open questions — probed and ANSWERED

**(a) Does grok support interactive tool approval headlessly in
`--permission-mode default`?** **NO.** With stdin held open and a prompt that
requires a shell command, grok emitted 16 `thought` deltas then ended the turn
with `stopReason:"Cancelled"` (`grok-approval-default.jsonl`). No
permission-request event was ever written to stdout and nothing waited on
stdin. Headless grok has no approval channel — a tool needing approval simply
cancels the turn. Supervised-style approval is UNAVAILABLE on grok; don't fake
it in the UI.

**(b) Can grok switch permission mode mid-session?** **Not live, but per-turn
YES.** There is no stdin control channel headlessly (no input-format flag
exists), so a mid-turn live switch is impossible → `livePermissionSwitch:
false`. However, each turn is a fresh process and `--permission-mode` may
differ on a `--resume` turn: the session cancelled in (a) was resumed with
`--permission-mode bypassPermissions` and the same command then executed to
completion (`num_turns:2`, `EndTurn`; file-write verified on disk in
`grok-turn4-filewrite.jsonl`). Grok's full mode list: `default`, `acceptEdits`,
`auto`, `dontAsk`, `bypassPermissions`, `plan`.

## Footguns (verified)

- **codex stdin:** `codex exec` reads piped stdin as additional prompt input —
  stderr prints `Reading additional input from stdin...` whenever stdin is not
  a TTY, and an open-but-silent pipe would hang the turn. The driver MUST pass
  the prompt as an argv argument and spawn the child with `stdin: 'ignore'`.
- **codex flag order:** global flags go BEFORE the `resume` subcommand —
  `codex exec --json -C <cwd> resume <id> "<prompt>"`. Putting `-C` after
  `resume` fails with `error: unexpected argument '-C' found` (exit 2).
- **codex unknown events:** only `thread.started`, `turn.started`,
  `item.started`, `item.completed`, `turn.completed` were observed — but parse
  defensively; ignore unknown types.
- **grok cost field:** `total_cost_usd` is a float; `total_cost_usd_ticks` is
  the same value ×10^10 — use the float.
