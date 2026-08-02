# UI improvements backlog

Deferred UI/UX polish surfaced during dogfooding — not blocking, batched for a
future "UI round". Newest first.

## No thread/project navigation below 960px

**Raised:** 2026-08-01, verifying US-506's narrow-shell fix (`dd0f8f0`) on the
isolated QA stack. Not a regression — the fix is a strict improvement on the
~207px chat column it replaced — but it introduces a gap that is easy to
rediscover as a bug.

**What happens.** `ui/src/v2/tokens.css:257` sets `display: none` on
`[data-slot="sidebar-panel"]` under `@media (max-width: 959px)`, mirroring
`--conan-shell-min-width: 960px`. That removes the rail from the layout **and
from the accessibility tree**. There is no toggle, no overlay drawer, and no
other affordance that brings it back.

So below 960px a user can keep working in the thread they already have open,
but cannot switch threads, start a new one, or reach a project. For a screen
reader the navigation is not merely off-screen — it is absent.

**Measured** at 480px on `dd0f8f0`: 0 visible thread rows, and the 13 visible
controls are `Back to Conan · Close Browser/Terminal/Diff tab · Surface ·
Actions menu · Open menu · Commit and Push menu · Scroll to bottom ·
provider·model · effort · permission mode · Send`. None reveals the sidebar;
`Back to Conan` was tried and does not.

**Three ways to close it**, in ascending cost:

1. **Explicit decision that v2 is desktop-only below 960px** — cheapest, and
   legitimate for a Tauri desktop app. Needs to be written down here and in
   `docs/v2-astryx-redesign.md`, not just assumed.
2. **A rail toggle in the toolbar** — smallest real UI. Reuses the existing
   sidebar; needs a persisted open/closed state and a visible focus target.
3. **An overlay drawer** — the conventional narrow-width pattern, and the most
   work: focus trap, dismissal (Escape / scrim / route change), scroll lock,
   and its own browser pass. Astryx ships `Dialog` and `Overlay`.

Whichever is chosen, it is a **new interaction surface**, which is why it was
deliberately kept out of `dd0f8f0` rather than improvised inside a CSS fix.

**Related:** US-506 (WHA-62, end-to-end live shell verification) stays open for a
different reason — US-504/US-505 (WHA-60/WHA-61) are deferred — so a green
WHA-62 later will not imply this gap is closed.

**Size:** S for option 1, S/M for option 2, M for option 3.

## Edit/Write approvals show the path, never the change

**Raised:** 2026-07-31, during the US-604 approval-card verification on the
isolated QA stack. Deferred to after p2d — not blocking US-604, which passed its
behavioural AC.

**The defect.** In v2's approval card (`V2ApprovalPanel.tsx`), a blocked `Edit`
or `Write` shows the tool name and the file path and nothing else:

```
Permission needed
Edit · calc.js
/private/tmp/…/fixture/calc.js
[Approve once] [Always allow this session] [Decline] [Cancel turn]
```

"Approve once" and especially "Always allow this session" are therefore decided
without seeing a single byte of what will be written. Observed live, not
inferred.

**Where the content is lost.** `permissionDetail()` (`src/agent/claude.ts:573`)
returns `inputTarget()` — `command` / `file_path` / `path` / `pattern` — and only
falls back to the full input JSON when there is *no* target. `Edit` has a
`file_path`, so its `old_string`/`new_string` are dropped. The emitted
`permission-request` event (`src/agent/driver.ts:183`) carries only `summary`,
`detail`, `toolName`, `toolUseId` — the raw `input` stays server-side in the
driver's `pendingPermissions` map and never reaches the client.

Worth naming the inversion: `ExitPlanMode` has no `file_path`, so it gets the
**full** input JSON and the UI hides it; `Edit` has its full input available and
the formatter throws it away.

**This is smaller than it first looks — the rendering is already built.**
`buildFileDiff(name, input)` (`ui/src/lib/diff.ts:143`) is a pure client-side
function that already parses `Edit` (`old_string`/`new_string`), `Write`
(`content`), and `MultiEdit` (hunks) straight out of the raw tool input and
returns a renderable `FileDiff`. `DiffView` (`ui/src/components/DiffView.tsx`)
already renders it as red/green rows. v1 wires the pair at
`ChatPane.tsx:2391`.

The "safe disclosure of large or sensitive inputs" problem is therefore already
solved twice in this repo, with settled policy:

- `buildFileDiff` degrades to counts-only (`lines: null`) on binary content or
  `chars > MAX_DIFF_CHARS` (200k) — `ui/src/lib/diff.ts:29`.
- `DiffView` caps rendered rows at `MAX_DIFF_ROWS = 600`.
- The gateway's own patch path caps at `MAX_PATCH_BYTES = 128 KiB` via
  `capPatch()` (`src/fs/diff.ts:38`).

**Shape of the work:**

1. Gateway — carry the raw tool `input` (or a diff-ready payload) on the
   `permission-request` event. This is the only server-side change and it is
   additive.
2. v2 UI — call `buildFileDiff(toolName, input)` in `V2ApprovalPanel` and render
   the result; fall back to today's mono block when it returns `null` (Bash,
   MCP tools, anything unrecognised).
3. v2 needs an **Astryx/StyleX `DiffView`** — the existing one is v1 Tailwind
   (`cn` + `text-emerald-600`). v2's own Diff surface will want the same
   primitive, so build it as a shared v2 component rather than inlining it in
   the approval card. This is the bulk of the effort.

**Settled 2026-08-01** (#conan thread; supersedes the open questions that stood
here):

1. **Collapsed by default** — a 12-row preview, then `Show full diff (+N −M)`.
2. **Action buttons stay pinned.** Approve/Decline hold their position whether
   the diff is collapsed or expanded; the diff region scrolls inside the card
   rather than pushing the buttons down the page.
3. **No redaction.** Full paths and full content — this is a local loopback UI
   and a truncated path is the defect being fixed.
4. **v2 only.** v1 (`ChatPane.tsx:2551`) deliberately keeps the bare-path card;
   v1 is frozen at parity and is not receiving the diff work. This section's
   heading reads as product-wide, so do not treat a green v2 as v1 also fixed.

**Size:** M — mostly the Astryx diff primitive, not the plumbing.

## Provider icon avatars (replace the C/X/G letters)

**Raised:** 2026-07-24.

**SHIPPED.** `d232abf` (2026-07-24) put brand icons in the sidebar avatar;
`ded21b6` (2026-07-25) added `ProviderMark.tsx` and Kimi as a fourth provider.
Brand SVGs are live in both shells:

- v1: `AgentAvatar` in `ChatSurface.tsx` resolves the provider id through
  `ProviderMark.tsx` / `PROVIDER_ICON` and inlines the SVG from
  `ui/src/assets/providers/`. Letter fallback is only for unknown providers.
- v2: `ProviderGlyph.tsx` (`ui/src/v2/chat/composer/ProviderGlyph.tsx`) uses the
  same shared assets.
- The unified provider/model picker also uses `ProviderMark.tsx` / `PROVIDER_ICON`,
  so the rail, trigger, and sidebar all share one source of truth.

Assets are `currentColor`-aware (`?raw` inline, not `<img>`) and include
`claude.svg`, `openai.svg` (used for Codex), `grok.svg`, and `kimi.svg`.

**Size:** S — closed, kept for provenance.

## Paste-to-attach (images) — shipped in v2 / paperclip redesign still deferred

**Raised:** 2026-07-24, during the daily-driver QA walkthrough. User doesn't
love the standalone paperclip; wants copy/paste into the input — especially
images — the way t3 does.

**What t3 actually does:** paste is *image-only*. `onComposerPaste` =
`clipboardData.files → filter image/* → addComposerImages`. Pasted TEXT just
types into the box; there is no "paste a text file's content" — that need is
served differently. So paste-to-attach does NOT replace Conan's file-content
pin (US-010): the paperclip attaches a repo file's TEXT by path (context);
paste attaches an IMAGE from the clipboard (multimodal input). Complementary.

**Image paste/drop SHIPPED in v2.** `RichInput.tsx` (`ui/src/v2/chat/composer/`)
wires `onDrop` to `onFiles`; `V2Composer.tsx:159-183` checks the selected
provider's `capabilities.imageInput`, reads pasted/dropped images with
`FileReader`, and stages them via `attachments.addImage(...)`. Image pins render
in the attachment drawer and serialize into the outgoing turn for providers that
accept them. Honest degradation when `imageInput: false`.

**Paperclip retirement / folding text-file pinning into `@`-mention flow —
still deferred.** The standalone paperclip still works for repo-file text pins
(US-010). Replacing it with a unified type/paste/`@` path is a redesign round,
not a bug fix, and is out of scope for the current loops.

Reference: `t3code/apps/web/src/components/chat/ChatComposer.tsx`
(`onComposerPaste`, ~line 1863), `composerDraftStore.ts` (image draft state).

**Size:** L — image half now closed; paperclip redesign remains backlog.

## Unified provider + model picker (T3 `ProviderModelPicker`)

**SHIPPED 2026-07-25** (`loop/conan-image-ui`). `ProviderModelPicker.tsx` +
`ProviderMark.tsx` (shared brand-mark module, dedupes `PROVIDER_ICON` with
ChatSurface). One popover replaces the provider chip + model chip in
`ChatPane.tsx`: a provider rail (brand marks; uninstalled disabled w/ reason,
active = check) + the browsed provider's model list. Only `modelSelection`
providers (Claude) show a model list; Codex/Grok degrade to a single honest
"runs on its own built-in model — Use <name>" commit row. Trigger face shows the
brand mark + provider name, appending `· <model>` only when a non-default Claude
model is chosen. Rail = browse-only; every commit is from the right panel, so
the interaction is uniform. Locked (turn 1 / resumed) → static mark+label+lock,
same as the old chips. Browser-verified: rail marks, Claude model list, Codex
degrade panel, and both commit paths ("Codex", "Claude Code · Opus") update the
trigger. Gates: gateway typecheck, 158 tests, ui build. Paperclip retirement
NOT included — deliberately deferred (see the paste/paperclip section above).

**Follow-up SHIPPED 2026-07-25 — real per-provider model selection.** `MODELS`
was hardcoded (Claude-only, missing Fable) and codex/grok had
`modelSelection:false`. Now every provider carries its OWN verified model list
in `capabilities.models` (`AgentModel` in driver.ts): Claude = `/model` aliases
(Default/Opus/Fable/Sonnet/Haiku), Codex = 8 verified CLI-cache ids
(`gpt-5.6-sol` … `gpt-5.3-codex-spark`, internal `codex-auto-review` omitted),
Grok = default + `grok-4.5` (from `grok models`). The picker reads each browsed
provider's list — no shared Claude list, no provider-name branching. The `-m`
plumbing already existed; the real fix was persisting the **launch** model
(client's `-m` id) instead of the **reported** one (grok's `grok-4.5-build` /
codex's none) — fixes the reopened-thread exit-1 bug and retires the DB
scrub-migration that would now wipe legit models. Gates: gateway typecheck, 160
tests (+2), ui build. Browser-verified all three panels. Still open: Grok's list
is dynamic-able (`grok models`) but wired statically for now (1 model today).

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
