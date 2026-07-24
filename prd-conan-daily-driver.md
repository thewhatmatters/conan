# PRD — Conan daily-driver polish (T3-5 · T3-11 · T3-6 · T3-3)

_Drafted 2026-07-24. Source: `docs/t3-port-backlog.md`. Builds on the
chat-primary, multi-provider Conan merged to `main` (`53ef5d0`)._

## 1. Problem

Conan's chat is complete enough to live in — it's now the tool being used to
build itself. What's missing is the stuff you only notice by *using* it daily:

- **You can't see how full the context window is.** The single most common
  "why did it get dumber / why did it compact" question has no answer in the
  UI. The terminal era had this (`session.context_tokens`); the chat era
  dropped it.
- **Every click of "New chat" creates a real thread row**, so an abandoned
  chat litters the sidebar forever.
- **No way to ask for more or less thinking.** Grok has a real
  `--reasoning-effort` flag; Claude responds to effort phrasing. Neither is
  reachable.
- **`@` mentions are only path references.** The agent re-reads the file, and
  there's no way to pin content you've already got.

## 2. Goal

Four independently shippable improvements to the everyday loop. Each must work
across **all three providers** or degrade honestly per the capability model —
no Claude-only controls.

## 3. Locked constraints (carried from T3-1)

- **No provider-name branching in the UI.** New per-provider behaviour rides
  `AgentCapabilities`, exactly like `permissionModes` / `modelSelection`.
- **Never render a control a provider can't honour** — absent or
  disabled-with-a-reason, never present-but-inert.
- **Never fabricate a number.** If context occupancy or a window size is
  unknown for a provider, say so; don't estimate silently.
- Subscription auth only; no `ANTHROPIC_API_KEY`.

## 4. Feature 1 — Context-window meter (T3-5, M)

**What exists today**

| Provider | Per-turn usage reported | In the `result` event? |
|---|---|---|
| Claude | `usage` incl. `input_tokens`, `cache_read_input_tokens` | **no** — driver emits `costUsd` only, usage dropped |
| Codex | `input_tokens`, `cached_input_tokens`, `output_tokens` | **yes** (`tokens`) |
| Grok | `input_tokens`, `cache_read_input_tokens`, `total_tokens` | **no** — driver emits `total_cost_usd` only |

So two of three drivers currently discard the numbers the meter needs.

**Two distinct quantities — don't conflate them** (the terminal era got this
right and `schema.sql` still documents it): per-turn *token usage* is not
context-window *position*. Position ≈ `input_tokens + cache_read_input_tokens`
of the latest turn — what the model is carrying, not what this turn cost.

**Build**

- Populate `tokens` on `result` for **all three** drivers (Claude and Grok
  currently drop it). This is additive — `costUsd` stays.
- Add `contextTokens` to the result event: the computed occupancy.
- A per-provider/model **window-size table** in the registry. Claude is
  200k (1M for the long-context model), Grok and Codex must be **probed and
  recorded, not guessed** — if a provider's window is unknown, the meter shows
  raw token count with no percentage rather than a fake ratio.
- Composer meter: a compact gauge showing occupancy, its percentage when the
  window size is known, and cost/tokens. Conan's differentiator over t3 is
  showing **cost alongside** — keep that.
- Degrades honestly: unknown window → count only; no usage reported → meter
  absent, not zeroed.

## 5. Feature 2 — Draft-based new-thread flow (T3-11, M)

Today `New chat` immediately creates a `chat_thread` row. t3 keeps a local
draft and promotes it on first send, reusing one empty draft per project.

**Build**

- "New chat" creates a local draft only. No DB row, no sidebar clutter.
- The draft holds its launch config (provider, model, permission, cwd) so the
  chips work before a thread exists — this is the hidden dependency.
- First send promotes the draft to a real thread; the row appears then.
- One reusable empty draft per project — clicking "New chat" twice doesn't
  make two.
- An abandoned draft leaves nothing behind.

## 6. Feature 3 — Reasoning-effort control (T3-6, M)

**Per-provider reality — verified 2026-07-24, not assumed:**

- **Grok**: `--reasoning-effort` (alias `--effort`), values **exactly
  `high | medium | low`** — the CLI validates client-side and names them
  (`unknown effort level 'bogus'; use one of: high, medium, low`).
- **Codex**: `-c model_reasoning_effort=<level>`. Confirmed a **recognized
  key**, not silently ignored: it passes `--strict-config`, which errors on
  unrecognized config fields.
- **Claude**: no flag. Effort is prompt-level phrasing ("think" /
  "ultrathink"), so this driver applies a prefix rather than an argument.

**Build**

- Add an effort descriptor to `AgentCapabilities` — the same shape as
  `permissionModes`: a list of options in the provider's own vocabulary, empty
  when unsupported (chip hidden).
- Each driver applies its own mechanism: Grok a flag, Claude a prompt prefix,
  Codex a config override — the UI never knows which.
- Persist the choice per thread; it rides the launch config.
- **Honesty note:** effort changes behaviour, but reasoning TEXT stays redacted
  for Claude and encrypted for Codex (D2). Don't imply the control reveals
  thinking.

## 7. Feature 4 — @-mention content pinning (T3-3, M)

Today `@` inserts a path string and the agent re-reads the file. Port this as
**real context attachments**, not prettier chips.

**Build**

- A pinned mention becomes a structured attachment on the turn: path + the
  content actually sent.
- Serialize pins into the outgoing prompt in a clearly delimited block, so the
  agent sees content rather than a path to re-read.
- Render pins in the transcript so it's visible what was actually sent —
  otherwise the transcript lies about the prompt.
- A size guard: a pinned file that would blow the context is truncated with an
  honest marker, never silently.
- Pins are per-turn, not sticky, unless explicitly kept.

## 8. Out of scope

- Image attachments (T3-2), diff viewer (T3-4), file browser (T3-16),
  worktrees (T3-7), keybindings (T3-17) — separate rounds.
- Terminal/element/preview context channels from t3's richer pinning — file
  pins only for v1.
- Auto-compaction or context-pressure actions. The meter *reports*; it doesn't
  intervene.
- Premium gating — the paywall is off (`PAYWALL_ENABLED = false`) and gating is
  deliberately deferred; **nothing in this round may add a gate**.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Window sizes are guesses | Probe each provider; unknown → show counts, no percentage. Never fabricate a denominator. |
| Claude/Grok usage plumbing touches working drivers | Additive only; `costUsd` untouched; parser tests over the existing fixtures. |
| Draft flow regresses thread persistence | The riskiest change — resume, reopen, and sidebar behaviour all get explicit re-verification. |
| Effort control becomes Claude-only UI | Capability-descriptor shape, same as `permissionModes`; empty list hides the chip. |
| Pinned content silently bloats the prompt | Bounded with a visible truncation marker; transcript shows what was sent. |

## 10. Story outline

1. Probe + record: per-provider context-window sizes and effort mechanisms.
2. Populate `tokens` + `contextTokens` on `result` for all three drivers.
3. Window-size table in the registry + expose via capabilities.
4. Composer context meter (occupancy, %, cost) with honest degradation.
5. Draft threads: local draft + launch-config state, no DB row.
6. Draft promotion on first send + one-draft-per-project reuse.
7. Effort descriptor on `AgentCapabilities` + per-driver application.
8. Effort chip in the composer, capability-driven.
9. `@` pin model: attachment structure + prompt serialization + size guard.
10. Pin rendering in composer + transcript.
11. Cross-provider QA + docs.
