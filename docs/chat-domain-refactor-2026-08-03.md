# Chat domain refactor — what changed and the new rules (2026-08-03)

> **Audience:** every agent working on `main-v2` (or merging it). Three
> commits landed from the architecture review (`d13c612`, `af0ff42`,
> `3f16e9c`). If you touch the transcript, the sidebar's domain types, or
> provider identity, read this first. Vocabulary: `CONTEXT.md` (new).

## 1. The transcript fold is now a pure reducer — `ui/src/chat/reducer.ts`

`useAgentChat` no longer holds state transitions. The whole session —
transcript items, busy, status, sessionId, permissionMode, capabilities,
contextTokens, approval queue — is one `ChatSessionState`, advanced only by
`reduceChat(state, action)`:

- **Actions** are a named union (`ChatAction`): server-originated
  (`server-event`, `busy`, `capabilities`, `server-error`) and local intents
  (`user-sent`, `approval-responded`, `client-error`, `connection-open`,
  `connection-error`, `connection-lost`).
- **Deterministic by contract:** timestamps ride on the action (`now`,
  stamped by the adapter — never call `Date.now()` in the reducer); item ids
  come from `state.seq`; the session re-init dedup is state
  (`lastInitSessionId`), not a ref. Same action stream ⇒ byte-identical
  state. This is also what makes it StrictMode-safe.
- **`useAgentChat` is now the adapter only** (socket, JSON parse, dispatch,
  outgoing frames). Its public `AgentChat` interface is byte-identical —
  no caller changed. Transcript types (`ChatItem`, `PendingApproval`,
  `SentPin`, …) are declared in `reducer.ts` and re-exported from the hook,
  so existing imports keep working.

**Rule:** new transcript/session behavior goes in the reducer as a new
action or case, with a test — not as a `useState`/`useEffect` in the hook or
a component.

**Tests:** `ui/src/chat/__tests__/reducer.test.ts` (29 table-driven tests;
suite is now 237). `ui/vitest.config.ts` include was widened to
`src/chat/__tests__/**` — shared-chat-domain tests go there, still not v1
component specs.

## 2. One chat domain model — `ui/src/chat/model.ts`

The types both trees had duplicated are now declared once:

| Now in `model.ts` | Replaced copies |
|---|---|
| `Project`, `SavedThread` | `ChatSurface.tsx` file-local · `useV2Projects.ts` (`V2Project`/`V2SavedThread` remain as aliases) |
| `HistoryItem` | `ChatPane.tsx` · `useV2ThreadHistory.ts` |
| `pillOf`, `Pill`, `ThreadPillState` | `ChatSurface.tsx` · `useV2ThreadState.ts` (aliases remain) |
| `fmtBytes` | `ChatPane.tsx` · `useComposerAttachments.ts` (re-export remains) |
| `asProviderId` narrowing | `App.v2.tsx`'s `asProvider` (deleted) |
| `PROVIDER_ICON` (in sibling `providerIcons.ts`) | `ProviderMark.tsx` · `ProviderGlyph.tsx` (both re-export) |

`ProviderId` (`"claude" | "codex" | "grok" | "kimi"`) is declared in
**`src/agent/driver.ts`** — the near-import-free seam both tsconfig programs
type-import — and re-exported by `registry.ts`. `model.ts` re-exports it for
the UI and narrows DB free-strings via `asProviderId` (a
`Record<ProviderId, true>` map makes a missing provider a compile error).

**Rules:**
- Never redeclare a domain type or provider union — import from
  `ui/src/chat/model.ts` (UI) or `src/agent/driver.ts` (gateway). The v2
  aliases (`V2Project`, `V2SavedThread`, `V2Provider`, `ThreadProvider`,
  `V2ThreadUiState`) are compatibility names, not places to add fields.
- Adding a provider: extend the union in `driver.ts`, and the compiler
  walks you through the rest (`PROVIDER_ID_SET`, registry, glyphs).

## 3. Live bugs fixed

- **v2 kimi coercion** — the redeclared provider unions had dropped `kimi`,
  so `asProvider` rendered saved kimi threads with the Claude glyph. Fixed
  structurally by the shared union (`af0ff42`).
- **v1 effort chip no-op on fresh threads** — `ChatPane.send()` never sent
  the chip's selection, only `resume?.effort` (`3f16e9c`).
- **StrictMode "Session started" drop** — the ref-mutation-inside-updater
  hazard is gone by construction (`d13c612`).

## 4. Still queued (deliberately NOT done — separate commits)

From the review's confirmed plan, in order:
1. **Restore `useV2Chat`'s dropped fields** (`capabilities`,
   `setPermissionMode`, `contextTokens`, `sessionId`, `reportError`) — v2's
   "Proceed in build" currently never leaves plan mode, and v2 has no
   context meter. First slice of review Candidate 6.
2. **Capabilities re-send patch** (gateway, Candidate 4's small fix):
   `src/agent/index.ts:87-95` re-sends capabilities on every `system` event
   via `capabilitiesForReportedModel`, nulling `contextWindowTokens` for 3
   of 4 providers. Rule to implement: launch-derived capabilities win; a
   reported model may refine, never null, the denominator.
3. Larger candidates not started: shared turn-process runtime behind the
   driver seam (Candidate 3), typed WS frames (Candidate 4), unified
   thread-history module (Candidate 5), remaining v2 pass-through deletions
   (Candidate 6).

Full review (6 candidates with evidence) lives in the 2026-08-03 session
transcript; the vocabulary it introduced is in `CONTEXT.md`.
