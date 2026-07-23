# Conan Chat V1 — Polish PRD

> Substantive refinements surfaced by the A–G QA walkthrough of the shipped
> `loop/conan-chat-v1` build. Trivial fixes (cursor, hover-reveal, skill label,
> dev What's New, spine centering) already landed by hand; this covers the six
> items that warrant a build loop.
>
> *Generated 2026-07-23 from docs/chat-v1-qa-backlog.md.*

## Problem

Conan Chat V1 passed QA functionally in every section (A–G), but living in the
build surfaced refinements that make the difference between "works" and "feels
right." None are bugs; all are UX gaps a real user hits in the first ten
minutes: a permission mode you can't change mid-conversation, a reload that
lands on an empty screen instead of your last chat, no visible way to reach
Settings or switch themes, a project picker that's a raw OS dialog instead of a
keyboard-navigable palette, no way to sort the sidebar, and skill markers on the
activity spine that don't stand out enough.

## Solution

Six focused stories, each independently verifiable in the browser, on top of the
existing chat-v1 surfaces. Backend is largely untouched — most of this is UI
wiring against contracts the loop already built (e.g. live permission switching
already exists via `useAgentChat.setPermissionMode`; thread reopen already
exists via US-015).

Out of scope (deferred): remote project sources (Git URL / GitHub clone),
close-thread confirmation dialog, and the D2 reasoning display (a platform limit
— headless `claude -p` redacts thinking text).

## Technical architecture

- **C1-a** unlock permission chip → route live changes through the existing
  `setPermissionMode` control-request path; pre-launch keeps local state.
- **B1-a** on boot, reopen the most-recently-active persisted thread (US-015
  flow) instead of the "No open chats" empty state.
- **G5-a** a sidebar gear + a direct ⌘, handler dispatching `conan:open-settings`
  (today only the native menu does), opening `SettingsView` (Appearance/License).
- **F4-a** stronger skill-tick styling in `ActivitySpine.tsx`, preserving the
  hierarchy + density guard (don't reintroduce the F7 clutter risk).
- **A9-b** a sort/group menu behind the sidebar header's ↑↓ icon, persisted to
  localStorage.
- **A1-a** a keyboard-navigable command-palette project picker (Local folder
  source only for now), replacing the raw folder dialog.

## Roadmap

- **This PRD (v1-polish):** the six items above.
- **Later:** A1-b remote clone sources; A8-a close-thread confirm; multi-provider
  via the AgentDriver seam; the release blockers (native Rust build, Premium
  meaning) — tracked separately, not loop work.

## Risks

- **A9-b + A1-a both touch the sidebar header** — sequential loop avoids
  conflicts, but they should be reviewed together.
- **F4-a can reintroduce clutter** — the spine's "graceful not cluttered" (F7)
  was the hardest-won property; the stronger skill tick must not tip it.
- **G5-a keyboard ⌘,** must not collide with the composer or browser defaults.

## Open questions

- A9-b scope: is "group by path / keep separate" wanted now, or just sort +
  visible-count for v1-polish?
- A1-a: keyboard palette with Local-folder only — enough, or does it need the
  recent-projects list inline too?
