# Conan v4 — research verdicts & locked decisions (2026-05-26)

Research pass over the 6 items captured in `docs/v4-backlog.md`. Codebase anchors
were re-verified against current code; open questions are resolved into the
decisions below. This feeds the **v4 PRD section** in
`prd-claude-code-dashboard.md` and the fresh `prd.json` (`loop/conan-v4`).

## Verified anchors (corrections in **bold**)

- **Item 1 — Pulse:** `ui/src/components/PulseChart.tsx`; rendered at
  **`App.tsx:316` as a standalone section below `PendingApprovals` — NOT the
  widgets row** (backlog said "widgets row"). tokens↔cost toggle at
  `PulseChart.tsx:142-158`. Payload `src/pulse/index.ts:46-70` is **global across
  all sessions** (no per-session filter); single consumer `usePulse → App → PulseChart`.
- **Item 2 — shadcn:** 11 primitives in `ui/src/components/ui/` (badge, button,
  card, command, dialog, dropdown-menu, popover, select, switch, tabs, tooltip).
  **12 of 24** app components import a primitive. Still raw `<button>`:
  `Dock.tsx` (Term ▾ + tabs, lines 282/308/325/336/361), `SessionBar.tsx`
  (221/272/279), `Sidebar.tsx` (48/68), `PendingApprovals.tsx` (93/99, hardcoded
  `"allow"|"deny"` at 4/94/100). dropdown-menu/select/popover/command/switch/tooltip
  each imported **exactly once** (shallow adoption confirmed).
- **Item 3 — Context widget:** binding `App.tsx:87-88`
  `sessions.find(s => s.status==="running") ?? sessions[0]`. `readContextUsage()`
  `src/transcript/index.ts:220-255` sums `input + cache_read + cache_creation` from
  the **last assistant message's `usage`**; fallback chain in `Widgets.tsx:322`
  `live?.used ?? session?.context_tokens ?? null` → "no usage yet" at 338. Returns
  null when transcript missing or no assistant `usage` line.
- **Item 4 — Permission:** `listPendingPermissions()` `src/session/index.ts:805`
  iterates **`byLaunchId` only** (driven sessions). `pending` populated from
  `control_request:can_use_tool` `src/session/parser.ts:215`; `permission_suggestions`
  captured at `:232` but **never used in UI**. `decidePermission()` `:854-864` writes
  to `live.child.stdin`, returns `{delivered, requestId}`. `POST .../permission`
  `src/gateway/index.ts:694-710` returns `{ok:true, ...result}` (carries `delivered`
  but UI ignores it). **`src/terminal/correlate.ts` EXISTS** (156 lines):
  `correlateClaudeSession(ptyPid, cwd)` maps pty→sessionId via
  `~/.claude/sessions/<pid>.json` + `ps`; plus `terminal_session.session_id` FK
  (`src/db/schema.sql:51-59`). **Keystroke-injection infra is present.**
- **Item 6 — Preview:** upgrade router `src/gateway/index.ts:825-845` runs
  `verifyUpgrade(req)` (auth+Origin) first, then path-matches `/ws`, `/ws/terminal`,
  else `socket.destroy()` — **a `/preview/` branch must be added before the
  catch-all** and inherits the auth gate. Static + SPA at `:740-742`. pty abstraction
  to mirror: `attachTerminal()`/`TermSession` in `src/terminal/index.ts` (ring buffer,
  onData/onExit, detach-grace survival). cwd state: `src/cwd/index.ts` —
  `getActiveCwd()`, `setActiveCwd()`, **`onCwdChange(fn)` subscription**; setter
  `PUT /api/cwd`; `/api/config` returns `{token,port,cwd}`. Deps: **`express`+`ws`
  only** (no proxy lib).

## Locked decisions (resolving the backlog's open questions)

1. **Pulse → bottom strip of the right dock, stays global, toggle removed.** Own
   pinned strip below the Terminal|Tasks tabs (not a third tab). Keep the global
   `src/pulse` payload; stop rendering `cost` (don't break payload consumers).
2. **Finish shadcn in 3 slices, avoid migrate-then-rewrite churn.** (a) extract
   shared patterns first; (b) Dock; (c) SessionBar + Sidebar. **PendingApprovals is
   NOT migrated here** — it's rewritten in item 4a, so do its `ui/button` adoption
   there. Componentize shared patterns: SortToggle, status dot, two-tier card shell,
   time-ago, scope badge. Fix the CLAUDE.md/memory note to "shadcn adopted, migration
   completing in v4."
3. **Context widget: fix binding + total-% first, then disk-based breakdown.** Bind
   to the **actually-live, pty-correlated** session (via `correlate.ts` /
   `terminal_session`), not `find(running)` over ~155 rows. Then **option B** for the
   category split — compute from disk (memory = CLAUDE.md+MEMORY.md sizes, skills =
   SKILL.md sizes, MCP from `~/.claude.json`, messages from transcript) as an honest
   approximation Conan owns. **Reject option A** (PTY `/context` scrape — too brittle).
4. **Permission: honesty floor + 3rd option now; keystroke-injection as its own
   story.** 4a — surface `delivered:false` (stop optimistic clear; mark
   "answer in terminal" when non-actionable), map `permission_suggestions` to buttons
   (3 options), migrate PendingApprovals to `ui/button`. 4b — inject keystrokes into
   the correlated pty to answer interactive/observed-session TUI prompts.
5. **Transcript sort:** reuse the extracted shared `SortToggle`, default
   **newest-first** per the ask; stable tie-break on `ts`/uuid.
6. **Preview: Replit-style host-process + same-origin reverse proxy** (NOT
   WebContainers — no COOP/COEP isolation needed). v1 scope = **run + proxy +
   preview**, no container sandboxing.
   - One new dep: **`http-proxy-middleware` (pin v3)** for `on:{proxyRes}` event API.
   - **Pin the port** rather than only scraping stdout: spawn Vite with
     `-- --port <free> --strictPort --base /preview/<id>/ --host 127.0.0.1`; keep a
     stdout `Local: http://localhost:NNNN` regex as the fallback for non-Vite tools.
   - **HMR gotcha:** the Vite HMR client silently falls back to dialing `:5173`
     directly unless told to dial back through `:3747`. Set `server.hmr.clientPort`
     = Conan port, `server.hmr.path` under `/preview/<id>/`, `protocol=wss` under TLS,
     injected via flags/env (don't edit the user's vite config).
   - **Framing:** in `proxyRes`, delete `x-frame-options` and strip
     `frame-ancestors` from CSP so the iframe always renders.
   - **WS:** build proxy with `ws:true`; in the new `/preview/` upgrade branch call
     `wsProxy.upgrade(req, socket, head)` so it sits behind the existing auth gate.
   - **Security floor:** an iframe `src` can't send the `x-conan-token` header, so
     `/preview/` HTTP relies on **same-origin + loopback + the Origin-checked WS
     upgrade** — same model as how the static SPA is served. Decided consciously.
   - **Command discovery:** read `package.json` scripts, default `dev`→`start`→
     `preview`, user-overridable per cwd. Subscribe to `onCwdChange` to stop/restart;
     **decouple preview process lifecycle from the gateway watch restart** (footgun #1).

## Sources (item 6 external)
- [Vite Server Options](https://vite.dev/config/server-options) — `port`, `strictPort`, `hmr.clientPort/path/protocol`, `base`
- [vite discussion #6473 — HMR behind a proxy](https://github.com/vitejs/vite/discussions/6473)
- [vite discussion #5399 — reverse proxy + HMR](https://github.com/vitejs/vite/discussions/5399)
- [http-proxy-middleware README](https://github.com/chimurai/http-proxy-middleware/blob/master/README.md) — `ws:true`, manual `.upgrade()`
- [http-proxy-middleware #712 — strip headers in proxyRes](https://github.com/chimurai/http-proxy-middleware/discussions/712)
- [StackBlitz WebContainers — cross-origin isolation](https://webcontainers.io/guides/troubleshooting) — why Conan uses the Replit proxy model instead
