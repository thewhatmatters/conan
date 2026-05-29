# MCP auth spike — driving the `/mcp` TUI (US-010)

_Date: 2026-05-28 · Branch: `loop/conan-v4.6` · Backlog F1 (S1)_

## Why this spike exists

`claude mcp --help` confirms there is **no auth subcommand** — the commands are
`add`, `add-from-claude-desktop`, `add-json`, `get`, `list`, `remove`,
`reset-project-choices`, `serve`. OAuth (re)authentication for a remote MCP
server is **only** reachable through the interactive `/mcp` TUI screen. So to
offer one-click Authenticate / Reconnect from Conan's HUD (US-011–US-014), a
backend driver must spawn a throwaway `claude` pty, open `/mcp`, navigate to the
target server, and fire its action — there is no headless path.

This spike drives `/mcp` in a real logged-in `claude` (v2.1.156) and records the
deterministic frame sequence. **Verdict: the TUI is reliably drivable** with a
**name-keyed** navigation (not an index keyed off `claude mcp list`). Recipe below.

## How the frames were captured

`scripts/spike-mcp-tui.mjs` — a throwaway-pty driver modeled on the `/usage`
probe (`src/usage/probe.ts`). It spawns `claude` via a login shell, sends
`/mcp\r`, then for each scripted key (`up,down,enter,esc,…`) writes the escape
sequence, waits, and dumps the **redraw delta** (only the bytes emitted since the
keypress — this isolates the cursor move). Raw + ANSI-stripped frames are written
to `scripts/fixtures/mcp-tui/frame-*.{raw,txt}` and are reused as US-011 unit-test
fixtures.

```bash
node scripts/spike-mcp-tui.mjs "down,down,down,down,down,enter"   # → Google Drive detail
node scripts/spike-mcp-tui.mjs "down,enter"                       # → paper (failed) detail
```

Caveat: ANSI-stripped frames have intra-line spaces collapsed by the TUI's
absolute-column cursor moves (e.g. `Status:△needsauthentication`), exactly like
the `/usage` capture — match against a whitespace-tolerant form, the same way
`parseUsageFrame` does.

## (a) Server ordering — `/mcp` does NOT match `claude mcp list`

Both views are account/install-global and **cwd-sensitive** (project-scoped
servers from `.claude.json [project:…]` only appear when `claude` runs in that
project). But the two views disagree on **membership and order**, so the driver
must **never** compute a row index from `claude mcp list`.

`/mcp` (run from `$HOME`), grouped by config source, selectable rows top→bottom:

| # | row (highlighted name)          | group              | status               |
|---|---------------------------------|--------------------|----------------------|
| 0 | `refero`                        | Local (project)    | connected · 8 tools  |
| 1 | `paper`                         | User               | failed               |
| 2 | `claude.ai Figma`               | claude.ai          | connected · 17 tools |
| 3 | `claude.ai Gmail`               | claude.ai          | connected · 12 tools |
| 4 | `claude.ai Google Calendar`     | claude.ai          | connected · 8 tools  |
| 5 | `claude.ai Google Drive`        | claude.ai          | needs authentication |
| 6 | `computer-use`                  | Built-in           | disabled             |

`claude mcp list` (same `$HOME` cwd) — **different order, and omits the built-in
`computer-use`**:

```
claude.ai Google Drive   - ! Needs authentication
claude.ai Google Calendar - ✓ Connected
claude.ai Gmail          - ✓ Connected
claude.ai Figma          - ✓ Connected
paper                    - ✗ Failed to connect
refero                   - ✓ Connected
```

The group order is essentially **reversed** between the two, the claude.ai group
is internally reversed, and `/mcp` adds the built-in row. **Conclusion: navigate
by reading the highlighted server name, not by a precomputed index.**

Header lines (`Local MCPs`, `User MCPs`, `claude.ai`, `Built-in MCPs`) are
**not selectable** — the cursor (`❯`) skips straight from `paper` to
`claude.ai Figma`, so down-count == distance in *selectable rows only*.

## (b) Navigation + Authenticate keypresses

The list screen footer is `↑/↓ to navigate · Enter to confirm · Esc to cancel`.
The cursor starts on the **first selectable row** (row 0). Each `↓` (`\x1b[B`)
moves one selectable row; the redraw delta reliably shows `❯ <server name> · <status>`,
so the driver can read where it landed after every keypress.

`Enter` (`\r`) on a row opens that server's **detail screen**, whose action menu
is **status-dependent** — the first/highlighted action is **not** always the one
we want, so select by **label**, not index:

| server status          | detail action menu (top→bottom, cursor on #1) |
|------------------------|-----------------------------------------------|
| needs-authentication   | `1. Authenticate` · `2. Disable`              |
| failed                 | `1. Authenticate` · `2. Reconnect` · `3. Disable` |
| connected (authed)     | `1. View tools` · `2. Re-authenticate` · `3. Clear authentication` · `4. Reconnect` · `5. Disable` |

Detail footer: `↑/↓ to navigate · Enter to select · Esc to back`.

**Deterministic recipe (name-keyed, label-keyed):**

1. `/mcp\r`, wait for the list to render (the `↑/↓ to navigate` footer is the
   ready sentinel).
2. From row 0, press `↓` up to (#selectable-rows) times; after each, parse the
   `❯ <name>` from the delta. **Stop when `<name>` matches the target server**
   (normalize whitespace/`·`). Bail if it wraps back to row 0 without a match.
3. `Enter` → detail screen. Wait for the `Enter to select · Esc to back` footer.
4. Parse the numbered action lines (`N. <label>`). Find the **0-based offset** of
   the desired label (`Authenticate` for needs-auth; `Reconnect` for failed; the
   cursor starts at offset 0). Press `↓` × offset, then `Enter`.
5. Done — `Esc`/kill the pty (see post-auth below).

For US-013's two routes:
- **authenticate** → target label `Authenticate` (offset 0 for needs-auth; offset
  0 for failed too — Authenticate is `1.` in both).
- **reconnect** → target label `Reconnect` (offset 1 on a failed server; offset 3
  on a connected one). If the target is `needs-authentication` (no Reconnect
  action), the route escalates to Authenticate — matching US-013's "escalate to
  authenticate only when the failure is auth-shaped".

## (c) Post-auth / pending frame

Selecting **Authenticate** immediately opens the OS browser and renders a pending
screen (captured in `frame-08-capture.txt`):

```
Authenticating with claude.ai Google Drive…
A browser window will open for authentication
If your browser doesn't open automatically, copy this URL manually (c to copy)
https://claude.ai/api/organizations/<org>/mcp/start-auth/<mcpsrv_id>?product_surface=claude-vscode
Press Enter after authenticating in your browser.
Esc to back
```

Key takeaways for US-011/US-012:

- **Consent is out-of-band in the browser.** The TUI just waits ("Press Enter
  after authenticating in your browser"). The throwaway pty has done its job the
  moment Authenticate fires + the browser opens — it can be killed; the OAuth
  handshake completes in the browser independent of the pty.
- **Therefore completion is detected by polling `claude mcp list` / `getMcpServers(true)`**
  until the server flips to `connected` (US-012), **not** by reading the TUI. This
  is exactly why US-012 polls rather than scraping the pending frame.
- The driver must **not** press Enter on the pending frame (that's the user's
  "I finished in the browser" signal); it spawns its own headless re-check loop
  instead.

## Verdict

The `/mcp` TUI is **deterministically drivable** for the auth/reconnect use case,
provided navigation is **name-keyed** (read `❯ <name>` per ↓) and the action is
**label-keyed** (read `N. <label>` on the detail screen). Index-from-`claude mcp
list` is **not** viable (ordering + membership + cwd all diverge). No brittle
pagination was observed at 7 servers in a 45-row pty; if a very long list ever
paginates, the name-keyed walk still terminates on the wrap-to-row-0 guard.

→ Proceed to **US-011** (throwaway-pty auth driver) using this recipe; the
captured frames in `scripts/fixtures/mcp-tui/` are the parse/navigation fixtures.
