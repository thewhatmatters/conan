# UI improvements backlog

Deferred UI/UX polish surfaced during dogfooding — not blocking, batched for a
future "UI round". Newest first.

## Paste-to-attach (images) + rethink the paperclip (T3-2)

**Raised:** 2026-07-24, during the daily-driver QA walkthrough. User doesn't
love the standalone paperclip; wants copy/paste into the input — especially
images — the way t3 does.

**What t3 actually does:** paste is *image-only*. `onComposerPaste` =
`clipboardData.files → filter image/* → addComposerImages`. Pasted TEXT just
types into the box; there is no "paste a text file's content" — that need is
served differently. So paste-to-attach does NOT replace Conan's file-content
pin (US-010): the paperclip attaches a repo file's TEXT by path (context);
paste attaches an IMAGE from the clipboard (multimodal input). Complementary.

**Feasibility — verified 2026-07-24 (all three CLIs accept images, differently):**
- Codex: `-i/--image <FILE>` — a file path.
- Claude: an `image` content block in `--input-format stream-json` (base64/inline).
- Grok: `--prompt-json` JSON content blocks (single-turn shape).

So image input is a per-provider capability (add an `imageInput` flag to
`AgentCapabilities`) and real plumbing: store the pasted image (temp file for
codex, base64 for claude, JSON for grok), send it the provider's way, render it
in the transcript. This is the backlog's **T3-2 "Image attachments" (L)** — a
proper round, not a tweak.

**Recommended shape for that round:**
1. Image paste → attach (the workflow the user wants), capability-gated.
2. Fold text-file pinning into the existing `@`-mention flow so the standalone
   paperclip goes away — one natural path (type / paste / `@`) instead of a
   button. Don't rip out the working US-010 pin blind; redesign paste + `@`
   together.

Reference: `t3code/apps/web/src/components/chat/ChatComposer.tsx`
(`onComposerPaste`, ~line 1863), `composerDraftStore.ts` (image draft state).

**Size:** L.

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
