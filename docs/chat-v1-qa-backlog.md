# Conan Chat V1 — QA backlog

Running list of updates/changes surfaced while walking the A–G QA checklist on
the `loop/conan-chat-v1` build. Status: **backlog** (queued) · **now** (fix in
the current polish pass) · **defer** (future release) · **done**.

Size: S (<30min) · M (a focused story) · L (multi-story / new subsystem).

---

---

## Polish loop (US-001..006) — dogfooded 2026-07-24

The 6 polish-loop stories were marked passing by the build loop but had never
been QA'd by hand. Walked live against the dev stack (real multi-provider
threads) with the automate-browser skill, light + dark.

Functional result: **all 6 pass.** One real defect was found and fixed (P6-b,
a padding bug in the shared CommandEmpty primitive); two unrelated findings
from the multi-provider work surfaced during the walk.

| Story | Result | Evidence |
|----|------|------|
| US-001 permission chip unlocked mid-conversation | **pass** | On a Claude thread with prior turns the chip is interactive and offers Supervised / Accept edits / Full access / Plan. |
| US-002 auto-open most recent thread | **pass** | Boot lands on the most recent thread (toolbar + spine + composer), never "No open chats". |
| US-003 in-UI Settings + theme | **pass** | Sidebar gear AND ⌘, both open Settings; tabs Status / Config / Appearance / License; Appearance offers Light / Dark / Auto. |
| US-004 stronger skill ticks | **pass (code-verified only)** | `ActivitySpine.tsx`: skill = `size-2 bg-primary ring-2 ring-primary/25` vs tool = `h-0.5 w-2 bg-muted-foreground/25` — clearly distinct, hierarchy intact. **Not observed live** — no thread in the dev DB has a fired skill. |
| US-005 sort / group menu | **pass** | Menu carries Sort projects (Last activity / Created / Manual), Sort threads (Last activity / Created), Group (By repository / By path / Keep separate), Visible threads. Persists via `conan-sidebar-view` in localStorage across reload. |
| US-006 command-palette project picker | **pass** | Palette, keyboard hints (↑↓ / ↵ / ⌫ / esc), "Local folder" source, and inline Recent projects all present — typing `con` surfaces the `conan` project for quick re-add. |

| ID | Item | Size | Status |
|----|------|------|--------|
| P6-a | ~~Recent projects are not offered in the palette.~~ **RETRACTED — QA error, not a defect.** Recents ARE implemented; the original check typed into the palette before the project list had loaded and read a truncated page tail, so it saw the empty state. Verified working: `con` → "Recent projects → conan ~/Development/conan". What the retest DID surface is P6-b. | — | **invalid** |
| P6-b | **Palette empty state had no padding/centering** — "No matching source." sat flush against the dialog's left edge. Root cause was in the `CommandEmpty` primitive (`ui/command.tsx`), not the caller: it set a literal `className` and then spread `{...props}` AFTER it, so a caller-supplied class REPLACED the defaults and silently dropped `text-center` + padding. Every sibling primitive in that file merges via `cn()`. Fixed at the primitive so all current and future callers benefit. | S | **done** |
| MP-a | **A model chip is rendered for providers that have no model selection.** Selecting Grok (or Codex) still shows a "Default model" chip, though `capabilities.modelSelection` is false for both. Not dangerous — the menu degrades to a single inert "Default model" entry rather than offering Claude models — but it is a dead control, and it violates the capability model's own rule that a provider never gets a control it can't honor. Hide the chip when `modelSelection` is false. | S | **done** |
| MP-b | **Empty-state copy hardcodes Claude.** A new chat reads "Drives `claude` headlessly in the active directory…" regardless of the selected provider — it still says Claude on a Grok or Codex thread. Should read from the registry like every other capability-driven surface. | S | **done** |

Notes:
- P6-a was a QA error on my part, retracted after the user demonstrated recents
  working. Lesson: let async lists settle before asserting an empty state, and
  read the rendered element rather than a slice of the page text.
- MP-a and MP-b are both instances of the same class the capability model
  exists to prevent — a surface that still assumes Claude. Neither is a
  correctness bug; both are honesty/polish.
- US-004 is the one story that could not be verified by observation. Triggering
  a real skill firing costs an agent turn; worth doing opportunistically the
  next time a skill fires naturally rather than paying for a synthetic run.

---

## A · Sidebar & projects — walked 2026-07-23

Functional result: **A1–A9 all pass.** Enhancements found:

| ID | Item | Size | Status |
|----|------|------|--------|
| A1-a | **Command-K style project picker.** Replace the plain folder dialog with a keyboard-navigable palette (↑↓ navigate · Enter select · Backspace back · Esc close), matching t3-code's "Sources" sheet. | M | backlog |
| A1-b | **Remote project sources** — Git URL / GitHub / GitLab / Bitbucket / Azure clone (t3-code's other Sources rows). Real cloning subsystem. | L | defer |
| A8-a | **Close-thread confirmation** — "Are you sure?" dialog before closing a thread. User: nice-to-have. | S | defer |
| A9-a | Hover-to-reveal new-chat icon on project rows. | S | **done** |
| A9-b | **Sort / group menu** — the ↑↓ header icon opens: Sort projects (last message / created / manual), Sort threads (last message / created), Visible-threads count, Group by repository / path / keep separate. | M | backlog |

Notes:
- A1-a and A1-b are related but separable — the keyboard palette (A1-a) stands
  alone; remote sources (A1-b) are a much bigger swing and genuinely future.
- A9-a is a ~2-line CSS change (opacity-0 + group-hover:opacity-100, the exact
  pattern the terminal tab close-button used).

---

## B · Persistence & resume — walked 2026-07-23

Functional result: **B1–B5 all pass at the data layer** (verified live: DB has
project + thread, survived gateway restart, reopen reconstructs transcript from
JSONL with the "Restored from history" divider). The issue is DISCOVERABILITY,
not persistence.

| ID | Item | Size | Status |
|----|------|------|--------|
| B1-a | **Auto-open the most recent thread on load** instead of the "No open chats" empty state. This is what makes persistence *feel* real — currently a refresh reads as "everything cleared" because nothing reopens. Every chat app (ChatGPT/Claude.ai/t3-code) does this. | S–M | backlog |
| B1-b | **Make saved thread rows read as resumable** — a subtle affordance (or the auto-open above) so it's obvious a sidebar row reopens a full conversation, not a dead label. Largely solved by B1-a. | S | backlog |

---

## C · Composer — walked 2026-07-23

Functional result: **C1–C10 all pass.** Findings:

| ID | Item | Size | Status |
|----|------|------|--------|
| C1-a | **Permission mode should NOT lock after the first turn.** Model + cwd locking is correct (one process = one model/dir), but the mode must be changeable mid-conversation (Supervised → Accept edits → Full access). The backend already supports this — `useAgentChat.setPermissionMode()` (US-022, the plan card's "Proceed in build") sends a live control-request switch. This is mostly UI wiring: unlock the permission chip; when a session is live use `permissionMode`/`setPermissionMode`, pre-launch use the local state as today. | S–M | backlog |
| C9-a | Pointer cursor on send/stop buttons. | S | **done** |
| C10 | General refinement — composer reads close to t3-code; polish opportunities as we go (ongoing, not a discrete task). | — | note |

---

## D · Transcript — walked 2026-07-23

Functional result: **D1, D3, D4, D5 pass. D6 pass (was mistaken for D1). D2 was a real BUG — now FIXED.**

| ID | Item | Size | Status |
|----|------|------|--------|
| D2-platform | **"Show reasoning collapsed" CANNOT be delivered in headless `claude -p`.** Root-caused by instrumenting the driver: the model DOES think (thinking_tokens counted), but the `thinking` TEXT is an empty string with only an encrypted `signature` — verified across claude-fable-5, opus, sonnet. Claude Code redacts thinking text in the `-p` API path (the interactive TUI has privileged access we don't). There is nothing to render. NOT our bug. Options: (a) leave the plumbing dormant (lights up if Anthropic ever exposes thinking text); (b) remove the reasoning UI to cut dead surface. Recommend (a) — it's harmless + future-proof. | — | platform-limit |
| D2-fix | While diagnosing, found + fixed a REAL parser bug anyway: suppression was per-message, not per-modality, so a model that streamed text-deltas but emitted whole-frame thinking would drop the thinking. Fixed + regression test (src/agent/claude.test.ts, 83/83 pass). Correct + future-proof, but does NOT make D2 visible today (text is empty regardless). Keep. | — | done (uncommitted) |
| D7 | Working indicator (elapsed + current tool) — not yet eyeballed; visible during a longer tool turn. | — | pending |
| D8 | Long tool-heavy turn readability — deferred (monitor). | — | defer |

Note: the D2 fix is committed-pending on `loop/conan-chat-v1` working tree
(src/agent/claude.ts + claude.test.ts) — fold into the polish batch or commit now.

---

## E · Approval — walked 2026-07-23

Functional result: **E1–E5 all pass.** Interactive Supervised approval works
end-to-end (panel raise, Approve/Always-allow/Decline/Cancel all behave). No
findings. E6 (protective vs annoying — the 👁 judgment call) still pending the
user's gut read after real use.

---

## F · Activity spine — walked 2026-07-23

Functional result: **F1–F5, F7 pass.** F7 (the big taste worry — graceful vs
cluttered) reads as GRACEFUL. Refinements:

| ID | Item | Size | Status |
|----|------|------|--------|
| F1-a | Vertically center the spine tick cluster (was top-jammed). | S | **done** |
| F4-a | **Better skill visualization** in the spine/timeline — skill ticks work (accent color) but deserve a stronger/clearer treatment so a fired skill is more legible at a glance. | S–M | backlog |
| F6 | Density guard (`+N` on tool-heavy turns) — **unverified**, hard to trigger manually (needs a 20+ tool turn). Can force it live if wanted. | — | pending |

---

## G · Shell & onboarding — walked 2026-07-23

Functional result: **G1 pass. G5 dark-mode RENDERING passes** (verified via
forced localStorage — sidebar/transcript/tool cards/composer all correct in
dark). G2/G3/G4 not testable in the browser dev context.

| ID | Item | Size | Status |
|----|------|------|--------|
| G5-a | **Theme/Settings unreachable in the chat UI.** Settings opens ONLY via the native menu (Conan ▸ Settings) — no in-UI affordance, no direct ⌘, handler. In the browser it's completely unreachable; even in Tauri it's buried with no visible entry now the HUD is gone. Settings also holds the **License tab**, so the whole Premium surface is hard to reach. Fix: add an in-UI entry point — a gear at the bottom of the sidebar (standard chat-app pattern) opening Settings ▸ Appearance/License. | S–M | backlog |
| G3 | Onboarding gate (install + hooks) — untested (first-run only). Can stub the missing-hooks state to verify. | — | pending |
| G4 | Native File menu (New/Close Chat) — **can't verify without the native build** → H pile. | — | H |

---

## Post-polish design (queued 2026-07-23, build AFTER the polish loop)

| ID | Item | Size | Status |
|----|------|------|--------|
| PD-1 | **Richer thread rows** — restyle each chat row in the sidebar like the reference: a **status icon (left)** · **title** (the summarized chat title) + a one-line **description** (last prompt or response, muted) · a **status badge / timestamp (right)**. Theme colors only (semantic tokens, no hex). Status→token map: Ready = check · `chart-2`; Working = spinner · `primary`; Awaiting approval = alert · amber/`destructive`; Idle = dot · muted; add a Failed/error state when a turn errors. **Description needs a data source**: either derive the last message from the reconstructed JSONL transcript, or persist a `last_message` preview on `chat_thread` at turn end (cheaper to render). Sequence AFTER US-002 (auto-open), US-003 (settings gear), US-005 (sort/group) since those reshape the same sidebar — building PD-1 first would be reworked. | M | **done** |
