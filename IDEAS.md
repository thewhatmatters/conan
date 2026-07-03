# Conan — Feature Ideas

## Decided — next build (not ideas; user calls, 2026-07-03)

- **"Auto" context tracking OFF by default.** Today
  `contextAutoRefreshEnabled` defaults ON (`src/terminal/index.ts:537`,
  `process.env.CONAN_CONTEXT_AUTOREFRESH !== "0"`). Flip it: default OFF; on
  only when the env var explicitly enables it (`=== "1"`) or the user turns
  on the Context widget's "Auto" toggle. Keep the runtime GET/POST endpoints
  (`src/gateway/index.ts` `/api/claude/context/autorefresh`) as-is; update
  the env-var semantics in both comments. Rationale: Auto spends context to
  measure context — that observer cost should be opt-in.
- **Both context-refresh controls disabled when Claude Code isn't running.**
  In the Context widget's refresh control group
  (`ui/src/components/Widgets.tsx` ~line 128): the manual "↻ /context"
  button is already gated on a live correlated pty (`hasLivePty`), but the
  "Auto" toggle renders whenever its state loads. Gate/disable the Auto
  toggle the same way — with no live `claude` session neither control can do
  anything, so both should read as disabled.

A running list of candidate features. Conan already nails "observe one Claude
Code session" — these either **deepen the observability**, **scale to many
sessions**, or **let you act from the HUD** instead of just watching. Each is
grounded in data the gateway already captures (hooks, transcripts, tokens,
skills, MCP) rather than bolting on something foreign.

## Deepen what we already capture
- **Session replay / time-travel scrubber** — we already store every `event` +
  token frame. A scrubber that replays a session's tool calls and
  context-window growth over time. Watch the context fill, see exactly which
  tool call blew it past 80%. Genuinely novel — no other tool visualizes this.
- **Context "weather forecast"** — extrapolate burn rate from Pulse/Context
  data and warn *before* auto-compact hits, with a one-click `/handoff`. Turns
  the reactive context-pressure bar into a predictive one.
- **Tool-call analytics** — heatmap of which tools fire most, which *fail*
  most, and median duration per tool. The hook stream already has everything;
  it's an aggregation + a Tremor chart.

## Scale to many sessions (flagship candidate)
- **Fleet view** — a grid of all live `claude` sessions, each a live tile:
  status dot, token burn, current tool, last activity. The HUD currently
  follows one active tab; a multi-session overview is the natural flagship and
  leans on the WS snapshot we already broadcast.

## Act, don't just watch
- **Away-from-keyboard alerts** — fire a native (or Discord/push) notification
  when a session is *blocked waiting for input* (permission prompt) or
  *finished*. Uses `useNativeNotifications` + the correlate/injection path we
  already have. Closes the loop so you can walk away from a long run. *(Likely
  same-day build — quickest win.)*
- **Command palette (⌘K)** + **prompt snippet launcher** — save common prompts
  and inject them into the correlated pty (we already do this for `/context`,
  `/usage`, `/handoff`). Makes the terminal feel like a real cockpit.
- **Git panel in the HUD** — show the working-tree diff Claude produced this
  session, with stage/commit from the HUD. StatusBar already reads branch/cwd.

## Share / close out
- **Export session → branded HTML report** — pipe a finished session's timeline
  + token/cost summary through the `render-html` skill into a shareable page.
  Great for "here's what the agent did" writeups.
- **Skill ROI / dead-skill finder** — we track `lastFiredAt` per skill; surface
  which skills *never* fire so the user can prune. Pairs with `refine-skill`.

## Already in the v0.2 backlog (tracked elsewhere)
- Transcript search (flagship), Cost forecast, News feed, Settings origin
  inspector. See `project_conan_v0_2_candidates` memory.

---
**Highest wow-per-effort:** Fleet view (most on-thesis, uses data we already
broadcast) and the session replay scrubber (genuinely unique).
