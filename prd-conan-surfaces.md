# Conan Surfaces — right-panel Browser · Terminal · Files · Diff (T3 parity)

> Bring T3 Code's "Open a surface" experience to Conan: a right panel beside
> the chat that opens a baked-in **Browser**, a workspace **Terminal**, a
> cwd-pegged **Files** explorer, and a thread-scoped **Diff** view — openable
> side by side as internal windows. Randy: *"absolutely mandatory that we get
> this experience right and always reference how the T3 build is in doing
> so."* Written 2026-07-25.

## The benchmark (non-negotiable)

**T3 Code is the reference implementation for every design decision in this
PRD.** Before building each surface, study T3's version of it first — its
entry points, empty states, sizing, and interaction grammar — and match the
*experience*, adapting only where Conan's stack (Tauri/WKWebView vs T3's
shell) forces a different mechanism. Concretely, from the 2026-07-25
screenshot and prior T3 sessions:

- **Entry**: an "Open a surface" empty state in the right panel — a card
  grid (icon + name + one-liner): *Browser — Open a local app or URL* ·
  *Terminal — Start a shell in this workspace* · *Files — Browse and read
  workspace files* · *Diff — Review changes in this thread*. Plus an "Open"
  control in the thread toolbar.
- **Panel model**: right panel with a draggable splitter; surfaces open as
  internal windows **side by side** (Randy explicitly wants the side-by-side
  behavior, not only one-at-a-time).
- **Scoping**: Terminal/Files peg to the thread's workspace (Conan: the
  thread's PROJECT cwd — US-025); Diff is scoped to *this thread's* changes.
- The `t3-code` MCP tools (`preview_*`) and `docs/t3-port-backlog.md` are
  available for studying T3 behavior live when a detail is ambiguous.

## Why Conan is closer than it looks (reuse map)

| Surface | Existing asset | State |
|---|---|---|
| Terminal | `src/terminal/index.ts` (node-pty, `/ws/terminal`, auth'd upgrade), `Terminal.tsx`/`TerminalPane.tsx` (xterm.js, mounted-but-hidden tab pattern), `getTerminalTheme()` | **Dormant, kept for reuse** — this is its comeback |
| Files | `FileExplorer.tsx` (dormant), `DirBrowser.tsx`/`ProjectPicker.tsx` (live), `GET /api/fs/read` + dir listing routes | Mostly exists |
| Diff | `DiffView` renderer in `ChatPane.tsx` (per-tool-card diffs, US-021) | UI exists; needs a thread-level data source |
| Browser | `/radio/embed` precedent (gateway-hosted iframe origin trick for WKWebView) | Hardest — see spike |

## Surfaces, in build order

### P1a — Files (S–M)
Revive `FileExplorer.tsx` in the right panel, pegged to the thread's project
cwd. Read-only v1: tree + file view via existing fs routes. Honor the
CLAUDE.md conventions TODO while remounting (its scrollbar doesn't match the
`aside`-scoped 6px themed scrollbar — fix via `<aside>` root or FadeScroll).
`h-9 shrink-0` header per the toolbar convention.

### P1b — Diff (M)
"Review changes in this thread." v1 data source: the files this thread's
tool calls touched (Edit/Write/MultiEdit inputs already stream through the
transcript) → gateway endpoint `GET /api/agent/threads/:id/diff` returning
per-file working-tree diffs (`git diff` scoped to those paths in the thread
cwd). Render with the existing `DiffView` row renderer in a file-grouped
list. Honest limitation v1: uncommitted working-tree state only; a
thread-start baseline ref is v2.

### P2 — Terminal (M)
Remount the dormant pty stack as a surface: `mode=shell`, cwd = thread
project path, xterm themed by `getTerminalTheme()`. The T3 grammar is "start
a shell in this workspace" — a PLAIN shell, not the agent's process.
⚠ Known footguns from the terminal era apply: WS-close kills the pty
(panel close should offer keep-alive or confirm), and gateway restarts kill
all ptys (dogfooding footgun #1).

### P3 — Browser (M–L, spike first)
"Open a local app or URL." The hard truth in a Tauri/WKWebView world:
arbitrary public URLs will NOT render in an `<iframe>` (X-Frame-Options/CSP
— the exact wall the Radio hit, solved then via the gateway-hosted
`/radio/embed` origin). Spike (timeboxed) before committing:
1. **Tauri v2 child webview** positioned over the panel region — a real
   browser surface, no framing limits; needs Rust-side work + z-order/resize
   discipline.
2. **iframe** — works day one for localhost dev apps (Conan's own :5173, any
   project dev server), breaks on most public sites. Possibly the honest v1:
   "local app preview," which is ALSO T3's primary use case ("open a local
   app").
Spike deliverable: a one-page decision doc; then build the winner.

## Cross-cutting

- **Panel shell first**: a `SurfacePanel` container in `ChatSurface` (right
  side, splitter, per-thread surface state, side-by-side split of 2 internal
  windows v1; n-windows is v2) with the T3 empty-state card grid. Every
  surface mounts into it.
- Per-thread state: which surfaces are open + sizes ride the thread UI state
  (in-memory v1; `chat_thread` persistence v2).
- Capability-driven, no provider branching — surfaces are workspace-scoped,
  provider-agnostic.
- Semantic tokens, `h-9 shrink-0` toolbars, shadcn primitives throughout.
- Each phase ships behind the established split: Claude specs + reviews +
  browser-verifies; Codex executes the file-scoped slices; the panel-shell
  UX and the Browser spike stay Claude-side (taste + Rust/webview risk).

## Phasing & gates

| Phase | Ships | Gate |
|---|---|---|
| 0 | Panel shell + empty-state card grid + splitter | typecheck/tests/build + browser QA |
| 1 | Files + Diff surfaces | same + a11y checklist on new panels |
| 2 | Terminal revival | same + pty lifecycle QA (close/reopen/restart) |
| 3 | Browser (post-spike) | same + the spike decision doc |

## Decisions (ratified by Randy, 2026-07-25)

0. **The panel is a TRUE THIRD COLUMN (corrected 2026-07-26).** It spans the
   full viewport height beside the chat column — ThreadToolbar, transcript,
   AND composer all belong to the middle column; the panel never sits above
   the composer or below the toolbar. (The loop's US-001 nested it in the
   transcript row; restructured same-day.)

1. **Side-by-side: 2-up v1.** Two internal windows max in the right panel;
   single-window view is the default, second window opt-in.
2. **Terminal close = KILL the shell.** No background/keep-alive — closing
   the panel terminates the pty, full stop. (Simplifies the lifecycle and
   sidesteps the orphaned-pty class of bugs from the terminal era.)

## Open questions (blocking only Phase 3)

1. Browser v1 scope: local-app preview only (iframe) vs full browser (child
   webview) — the spike decides, Randy ratifies.
2. Does Diff need commit/stage actions v1, or read-only review? (Assuming
   read-only.)

## Browser v1 decision — iframe (spiked + ratified by build, 2026-07-25)

**v1 ships the iframe path** (US-007): local-app preview, honest refusal for
everything else. The spike settled the detection question empirically:

- Chrome fires the iframe `load` event even for X-Frame-Options/CSP-blocked
  frames (measured: github.com "loads" in ~170ms, a dead port in ~9ms) — a
  deliberate anti-probing measure — and a blocked frame's document is exactly
  as opaque as any legit cross-origin one. **Client-side refusal detection is
  impossible in Chrome**; a load/timeout heuristic alone would show blocked
  sites as silent blank frames.
- Detection therefore runs through the gateway: `GET /api/browser/probe`
  (token-gated, CORS-reflected) fetches the target's response headers and
  decides frameability from `X-Frame-Options` + CSP `frame-ancestors`
  (approximate source matching, erring refused = honest). The client's
  load-timeout heuristic remains as the fallback when the probe route is
  unavailable (stale gateway).
- Refused targets get the honest state — "This site refuses to be embedded —
  Browser v1 previews local apps" — with an *Open in system browser* link.

**What the Tauri child-webview v2 adds:** a real browser surface with no
framing limits (github.com, docs sites, anything), because a child
`WebviewWindow`/`Webview` positioned over the panel region is a top-level
browsing context that XFO/CSP `frame-ancestors` never applies to. Cost: Rust
work (create/position/resize/z-order the child webview in `src-tauri/`, keep
it glued to the panel rect through splitter drags and window resizes), plus
nav chrome (back/forward/history) — deliberately kept out of the autonomous
loop per this PRD's phasing.
