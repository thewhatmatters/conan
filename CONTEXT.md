# Conan Chat

The chat-primary app's domain: headless coding-agent sessions (Claude Code /
Codex / Grok / Kimi) driven over a WebSocket and rendered as threads in a
custom transcript UI. Created during the 2026-08 architecture review; terms
land here as seams get real names.

## Language

**Chat session state**:
The entire client-side state of one live agent session — transcript, busy
flag, approval queue, capabilities, context position — held in one
`ChatSessionState` (`ui/src/chat/reducer.ts`).
_Avoid_: chat state, hook state

**Transcript fold**:
The pure reduction of agent events and local intents into the chat session
state — `reduceChat(state, action)`. Deterministic: timestamps ride on the
action, item ids come from `state.seq`.
_Avoid_: applyEvent, event handler

**Chat domain model**:
The types and resolution helpers both UI trees share (`ui/src/chat/model.ts`):
`Project`, `SavedThread`, `HistoryItem`, `ProviderId` narrowing, the sidebar
pill derivation. Neither tree declares its own copies.
_Avoid_: shared types, common types

**Provider**:
One of the registered coding agents (`claude` · `codex` · `grok` · `kimi`).
The union `ProviderId` is declared once, in the driver seam
(`src/agent/driver.ts`); everything else imports it.
_Avoid_: agent (ambiguous with a running session), model (that's a provider's
LLM choice)

**Driver seam**:
The `AgentDriver` interface (`src/agent/driver.ts`) that hides each
provider's process/wire shape behind normalized `AgentEvent`s and
capabilities.
_Avoid_: driver API, provider interface

**Thread**:
One conversation with one provider in one project, persisted as a
`chat_thread` row (`SavedThread` client-side) and resumed via the provider's
own resume mechanism.
_Avoid_: conversation, session (a session is one live run of a thread)
