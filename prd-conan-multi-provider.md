# PRD — Conan multi-provider (T3-1)

_Drafted 2026-07-23. Source: `docs/t3-port-backlog.md` T3-1. Builds on the
chat-primary Conan (`loop/conan-chat-v1`)._

## 1. Problem

Conan drives exactly one coding agent: Claude Code. The `AgentDriver` seam
(`src/agent/driver.ts`) was designed for more, but `src/agent/index.ts`
hard-instantiates `ClaudeDriver` and the UI assumes Claude's capabilities
(interactive approval, live permission-mode switching, token deltas, USD cost).

Consequences:

- **No failover.** When Claude credits run out, Conan is dead weight even
  though Codex and Grok are installed and authenticated on the same machine.
- **Single-vendor lock.** Conan's pitch is "a cockpit for driving coding
  agents", not "a Claude skin". Multi-provider is the biggest differentiator
  vs. a Claude-only wrapper.
- **The seam is unproven.** An interface with one implementation is a guess.
  Until a structurally different agent runs behind it, we don't know if it's
  right.

## 2. Goal

Run **Claude, Codex, and Grok** behind the existing `AgentDriver` seam, with
the UI adapting honestly to what each provider can actually do — no faked
capabilities, no silent degradation.

**Success:** a user picks a provider in the composer, sends a turn, sees
streamed output, tool calls, and a correct per-provider permission control;
reopening the thread resumes on the same provider.

## 3. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Capability gaps | **Per-provider capability degrade** | Each driver declares capabilities; UI adapts. Honest, and scales to future providers. |
| v1 scope | **Codex + Grok** (plus existing Claude) | Codex is structurally alien, Grok is Claude-like — together they prove the abstraction at both ends. Cursor/OpenCode deferred. |
| Provider selection | **Composer chip, locked after turn 1** | Matches the existing launch-config model (model/cwd already lock). t3 does the same. |
| Failover | **Manual only** | Context cannot transfer between CLIs; auto-switching would silently change agent, model, and capabilities. |

## 4. The core design problem: capabilities

The three CLIs are **not** feature-equivalent. Verified by probing the
installed binaries (`claude` 2.x, `codex-cli` 0.144.6, `grok` 0.2.111):

| | Claude | Codex | Grok |
|---|---|---|---|
| Headless flag | `--print --output-format stream-json` | `exec --json` | `-p --output-format streaming-json` |
| Process model | one long-lived process, many turns | **one process per turn** | one process per turn (`-p` is single-turn) |
| Multi-turn continuity | stdin `stream-json` | `exec resume <thread_id>` | `--resume <session_id>` |
| Token deltas | yes (`--include-partial-messages`) | **no** (completed items only) | **yes** (verified) |
| Reasoning text | **redacted** (empty + signature only — D2) | not observed | **visible** (verified) |
| Interactive approval | yes (stdio control channel) | **none** (sandbox chosen at launch) | unverified — probe in story 1 |
| Permission model | `default/plan/acceptEdits/bypassPermissions` | `--sandbox read-only/workspace-write/danger-full-access` | same names as Claude |
| Live mode switch | yes, mid-session | no (next turn only) | unverified — probe |
| Cost | `total_cost_usd` | token counts only | **`total_cost_usd`** (verified) |

**Grok's observed event shape** (`grok -p --output-format streaming-json`):

```json
{"type":"thought","data":"The user wants…"}
{"type":"text","data":"grok-probe-ok"}
{"type":"end","stopReason":"EndTurn","sessionId":"019f91ed-…",
 "usage":{…},"num_turns":1,"total_cost_usd":0.0313684}
```

### Bonus outcome: reasoning stops being impossible

Conan's reasoning UI is dormant because headless `claude -p` redacts thinking
text (empty string + signature only — the D2 platform limit, verified across
fable/opus/sonnet). **Grok does not redact it** — `thought` deltas carry real
reasoning prose. So the collapsed-reasoning transcript UI, already built and
shelved, becomes live for Grok. This is a capability flag (`reasoningText`),
not a special case: Claude sets it false, Grok true.

**Codex's observed event shape** (`codex exec --json`):

```json
{"type":"thread.started","thread_id":"019f91e8-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"probe-ok"}}
{"type":"turn.completed","usage":{"input_tokens":17507,"cached_input_tokens":13056,"output_tokens":6}}
```

### 4.1 Capability descriptor

Every driver declares what it supports. The UI reads this — never a provider
name — so a fourth provider needs no UI changes.

```ts
export interface AgentCapabilities {
  /** Token-by-token deltas. False → UI shows a working indicator, not a caret. */
  streamingDeltas: boolean;
  /** Interactive per-tool approval (Supervised). False → no approval UI. */
  interactiveApproval: boolean;
  /** Permission mode can change mid-session. False → next turn only. */
  livePermissionSwitch: boolean;
  /** Reports real USD cost. False → cost footer shows tokens, not dollars. */
  costUsd: boolean;
  /** Emits readable reasoning prose. Claude redacts it headlessly (D2), Grok
   *  does not — this flag is what un-shelves the collapsed-reasoning UI. */
  reasoningText: boolean;
  /** The permission/sandbox options this provider actually offers, in the
   *  provider's own vocabulary — the composer chip renders these verbatim. */
  permissionModes: Array<{ id: string; label: string; description: string }>;
  /** Resume a prior conversation. */
  resume: boolean;
}
```

**Rule: no lying.** If a provider can't do a thing, the control is absent or
disabled-with-reason — never present-but-inert. A Codex thread shows a sandbox
chip (`read-only` / `workspace-write` / `full-access`), not a Supervised chip
it cannot honor.

## 5. Architecture

### 5.1 Backend

- **`src/agent/driver.ts`** — add `AgentCapabilities` + `readonly capabilities`
  on `AgentDriver`. Existing `AgentEvent` union stays; it already covers what
  Codex/Grok emit (`system`, `assistant-text`, `tool-use`, `tool-result`,
  `result`, `exit`, `error`).
- **`src/agent/registry.ts`** (new) — provider registry: id, display name,
  avatar letter, binary name, factory, capabilities, install probe. The single
  place a provider is added.
- **`src/agent/codex.ts`** (new) — `CodexDriver`. Spawns `codex exec --json`
  per turn (`exec resume <thread_id>` after the first), maps `thread.started`
  → `system`, `item.completed` → `assistant-text`/`tool-use`/`tool-result`,
  `turn.completed` → `result`. `interrupt()` kills the turn process (documented
  fallback). `respondPermission()` is a no-op — the capability says so.
- **`src/agent/grok.ts`** (new) — `GrokDriver`. Closest to Claude:
  `-p --output-format streaming-json --resume`. Probe whether headless approval
  and live mode switch actually work; set capabilities to the **verified**
  truth, not the flag list.
- **`src/agent/index.ts`** — instantiate from the registry using the `provider`
  on the WS launch frame; default `claude`.
- **`GET /api/agent/providers`** — installed/available providers + their
  capabilities, for the composer chip. Reuses the `src/doctor/` login-shell
  PATH probe pattern.

### 5.2 Persistence

- `chat_thread.provider TEXT` (nullable, default `claude`) via the idempotent
  `migrate()` path in `src/db/index.ts` — the same pattern as `last_message`.
- Resume must use the **same provider** that created the thread; a Claude
  session id means nothing to Codex.

### 5.3 UI

- **Composer** — a provider chip beside the model chip, listing installed
  providers (uninstalled shown disabled with why). Locks after the first turn
  with the rest of the launch config.
- **Permission chip** — rendered from `capabilities.permissionModes`, so it
  says "Supervised" on Claude and "workspace-write" on Codex.
- **Transcript** — when `streamingDeltas` is false, show a working indicator
  instead of a streaming caret. When `costUsd` is false, the turn footer shows
  tokens.
- **Sidebar avatar** — already built: `agentOf()` in `ChatSurface.tsx` returns
  `C`/`X`; extend to the registry so it's provider-driven, not model-sniffed.

## 6. Out of scope

- **Auto-failover** (decided: manual).
- **Cursor / OpenCode / Gemini** — not installed here; the registry makes them
  additive later.
- **T3-19 provider install/update maintenance UI** — rides behind this.
- **Cross-provider context transfer** — impossible; not attempted.
- **Image attachments** (T3-2), per-provider auth management.

## 7. Risks / unknowns

| Risk | Mitigation |
|---|---|
| Grok's headless approval + live switch are unverified | Probe first (story 1); set capabilities to verified behavior. Falling back to "no interactive approval" is acceptable. |
| Codex per-turn respawn loses in-memory state | It's the documented model; `exec resume` carries the thread. Verify multi-turn continuity explicitly. |
| Codex `exec` reads stdin when piped ("Reading additional input from stdin…") | Pass the prompt as an argument and give the child `stdin: "ignore"`. |
| Event-shape drift across CLI versions | Parsers must ignore unknown event types rather than throw; pin observed shapes in unit tests. |
| Scope creep into a full provider subsystem | Registry stays a data table, not a plugin framework. |

## 8. Story outline

1. Probe + document Grok/Codex headless behavior; write the capability matrix
   as tests/fixtures.
2. `AgentCapabilities` on the driver seam + Claude's descriptor (no behavior
   change).
3. Provider registry + `GET /api/agent/providers` install probe.
4. `CodexDriver` — spawn, parse, resume, interrupt.
5. `GrokDriver` — spawn, parse, resume, interrupt.
6. `chat_thread.provider` migration + resume routing by provider.
7. WS launch frame carries `provider`; `index.ts` builds from the registry.
8. Composer provider chip (installed/disabled states, locks after turn 1).
9. Capability-driven permission chip.
10. Capability-driven transcript (no-delta indicator, token-vs-USD footer).
11. Sidebar avatar from the registry.
12. Cross-provider QA: a thread per provider, multi-turn, resume, interrupt.
