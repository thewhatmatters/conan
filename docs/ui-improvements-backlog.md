# UI improvements backlog

Deferred UI/UX polish surfaced during dogfooding — not blocking, batched for a
future "UI round". Newest first.

## Unified provider + model picker (T3 `ProviderModelPicker`)

**Raised:** 2026-07-24, during the daily-driver QA walkthrough.

Today the composer has **two separate controls** — a provider chip ("Claude
Code") and a model chip ("Default model"). t3-code fuses them into **one
popover**: a provider rail down the left (icon per provider + a favorites star),
a "Search models…" input, and a scrollable model list on the right — each row is
`Model name / provider` with a check on the selected one, a `⌘N` shortcut hint,
and a favorite star. The trigger chip shows just the selected model
(`Claude Opus 4.8 ▾`).

Want: collapse Conan's provider + model chips into a single picker like that —
provider and its models within one reach, no two-hop.

**Conan adaptation (don't copy t3 blindly):**
- Rail = the 3 providers (C/X/G); uninstalled ones disabled with a reason.
- Right panel: only **Claude** has selectable models (Default / Opus / Sonnet /
  Haiku). **Codex/Grok have `modelSelection: false`** — they'd show no model
  list (they run their own default), so the picker must degrade honestly rather
  than invent per-provider model lists t3 gets from live provider APIs.
- Reference: `t3code/apps/web/src/components/chat/ProviderModelPicker.tsx` +
  `ModelPickerContent.tsx`.
- Replaces the two chips in `ChatPane.tsx` (provider chip US-008 + model chip).

**Size:** M.

## Context-window "Default model" resolves to 200k, not the real default

**Raised:** 2026-07-24.

The context meter's denominator comes from the **model picked in the chip**, not
the model Claude actually runs. On a fresh thread with "Default model" selected,
`contextWindowFor("claude", undefined)` → the registry's `default` = 200k — but
Claude's real default is `claude-fable-5` (1M). So the ring shows a 200k
denominator while the session is really on a 1M window.

Fix candidates: (a) point the registry's claude `default` at 1M if fable-5 is
genuinely the CLI default, or (b) resolve the window from the model the system
event **reports** (`e.model`) rather than the launch model, updating the
capabilities/meter once the real model is known. (b) is more correct but needs
the window to update post-init.

**Size:** S.
