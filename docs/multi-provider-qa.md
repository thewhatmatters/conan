# Multi-provider QA — T3-1 (US-012)

_Run 2026-07-23 on branch `loop/conan-multi-provider`, browser dev stack
(throwaway `CONAN_PORT=3796` + Vite `:5196`), driven with the automate-browser
skill. CLI versions: claude 2.1.218 · codex 0.144.6 · grok 0.2.111. Test cwd:
a scratch folder (`~/conan-qa-us012`), never a real repo._

Protocol per provider: send 2 turns (turn 1 plants a codeword, turn 2 asks it
back — proves cross-turn context), interrupt a long turn mid-flight, then close
and reopen the thread and confirm it resumes on its OWN provider.

## Result matrix

| Check | Claude | Codex | Grok |
|---|---|---|---|
| 2-turn context retained | ✅ "peridot" | ✅ "zephyr" (via `codex exec resume`) | ✅ "quasar" (via `--resume`) |
| Turn footer | ✅ $ cost | ✅ token counts ("17.7k in · 5 out"), no fabricated $ | ✅ $ cost |
| Streaming | ✅ token deltas | ✅ honest Working indicator, whole message at end | ✅ token deltas + streamed partial text |
| Reasoning rows | hidden (D2 — headless claude redacts thought text) | n/a (none emitted) | ✅ "Thinking" rows render per turn (expansion with real thought text verified in US-010) |
| Interrupt mid-turn | ✅ stream stops, turn closes (footer reads $0.0000 — cosmetic) | ✅ process killed → "Session ended." | ✅ partial text kept → "Session ended." |
| Turn after interrupt | ✅ context intact ("peridot") | not retestable same-session (one process per turn — next send starts a new process anyway) | ✅ (same one-process-per-turn model) |
| Reopen → own provider | ✅ relaunches claude | ✅ relaunches codex (verified: `codex exec` spawned, never claude) | ✅ relaunches grok |
| Reopen → transcript restored | ✅ "Resumed from history", context intact | ✅ FIXED 2026-07-24 (rollout reader) | ✅ FIXED 2026-07-24 (chat_history reader, Thinking rows intact) |
| Reopen → conversation continues | ✅ | ✅ FIXED 2026-07-24 (quoted a pre-reopen question) | ✅ FIXED 2026-07-24 (quoted a pre-reopen question) |

## Known limitations (honest, by design or deferred)

### 1. ~~Codex/Grok threads lose their conversation on close+reopen~~ FIXED 2026-07-24

Transcript reconstruction (`src/agent/history.ts`) reads **Claude's JSONL
only**. For a codex or grok thread the transcript route finds nothing, the UI
shows "This chat's saved history couldn't be found on disk — your next message
starts a fresh session in this project", and `ChatPane.tsx` (~line 509)
deliberately drops the `--resume` id when history is missing — so the next
message starts a **fresh session on the same provider**. Deliberate degradation
(the agent would otherwise know context the visible transcript doesn't show),
but it means close+reopen is lossy on codex/grok while a thread's pane stays
mounted-but-hidden fine within an app run.

Side effect: the fresh session gets a new session id, so sending a message in
a reopened codex/grok thread creates a **duplicate sidebar row** (the original
row survives untouched).

**Codex: FIXED.** `src/agent/codexHistory.ts` reads Codex's rollout JSONL
(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl` — the
session id Conan persists is in the filename, and `codex exec resume` appends
later turns to the SAME file, so one file is the whole conversation). It maps
`message` → user/assistant (dropping `developer` records and Codex's injected
`<recommended_plugins>` / `<environment_context>` / AGENTS.md user messages),
and `function_call`/`custom_tool_call` → tool cards merged with their outputs
by `call_id`. Codex's `reasoning` records are encrypted with an empty summary
(verified across every local rollout), matching `reasoningText: false`, so
they're skipped rather than rendered blank. Unknown record types are ignored so
a CLI version bump can't break the reader. The transcript route dispatches by
the thread's provider. Because history is now FOUND, ChatPane keeps the resume
id, so reopened codex threads also continue the real conversation — verified
end-to-end: after close+reopen, Codex correctly quoted the pre-reopen question.

**Grok: FIXED.** `src/agent/grokHistory.ts` reads
`$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<session_id>/chat_history.jsonl`
— the thread's cwd makes this a direct path hit, with a one-level scan as
fallback; the `session_search.sqlite` index turned out to be unnecessary.
`--resume` reuses the original session id (only `--fork-session` mints a new
one, which the driver never passes), so later turns append to the same file.
It unwraps the real prompt from Grok's `<user_query>` envelope, drops injected
`<user_info>` / `<system-reminder>` user records, emits reasoning rows from the
READABLE `summary_text` (Grok's differentiator — Claude redacts, Codex
encrypts), and merges `assistant.tool_calls` with their `tool_result` by
`tool_call_id` (Grok has no separate tool_call record). Verified end-to-end:
after close+reopen the restored transcript shows its Thinking rows and Grok
quoted the question asked before the reopen.

All three providers now restore transcripts and continue conversations across
close+reopen.

### 2. ~~BUG — reopened Grok threads cannot send any turn (exit 1)~~ FIXED 2026-07-24

The thread row persists the model the driver *reports* (`upsertChatThread`
`model: e.model` in `src/agent/index.ts`). Grok's stream reports its internal
build name — `grok-4.5-build` — which is **not a valid `-m` model id**. On
reopen the saved model is re-applied to the launch (`ChatPane.tsx` ~502,
`resume.model`), so every turn dies with:

```
Error: Couldn't set model 'grok-4.5-build': Invalid params: "unknown model id".
```

Claude is unaffected only by luck (it reports a valid alias like
`claude-fable-5`); codex reports no model (null → no `-m`). Fix direction:
don't re-apply a saved model the user never picked (non-claude providers have
no model options — resume should omit `-m` for them), or have GrokDriver stop
reporting the build name as the launch model.

**Fixed** by separating a *reported* model (telemetry) from a *launch* model
(user intent), which is what the original code conflated. A new
`AgentCapabilities.modelSelection` flag says whether a provider's reported
model is a valid `--model` id worth re-applying: claude true, codex/grok
false. `src/agent/index.ts` now persists `e.model` only when that flag is set,
so nothing invalid can be saved for any current or future provider. Because
the upsert `COALESCE`s the model (a null write keeps the old value), an
idempotent migration in `src/db/index.ts` also clears already-poisoned rows
(`provider <> 'claude' AND model IS NOT NULL`) so existing threads recover.
Verified end-to-end: the previously-broken grok thread now sends a turn and
replies with no `unknown model id` error.

### 3. Cosmetics

- Interrupted claude turn footer shows `$0.0000` for cost.
- `codex exec` still prints "Reading additional input from stdin..." to stderr
  even with stdin ignored — benign (it sees EOF and proceeds); logged noise
  only.

## What's solid

The capability model held up end-to-end with zero provider-name branching in
the UI: the composer chip locks after turn 1, the permission chip renders each
provider's real vocabulary (Codex sandbox modes, Supervised absent), the
transcript adapts (Working indicator vs caret, token counts vs $, Thinking
rows only where reasoning text is real), and sidebar avatars C/X/G come from
the persisted per-thread provider. Within a single app run all three providers
hold multi-turn conversations and interrupt cleanly.
