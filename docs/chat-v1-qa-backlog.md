# Conan Chat V1 — QA backlog

Running list of updates/changes surfaced while walking the A–G QA checklist on
the `loop/conan-chat-v1` build. Status: **backlog** (queued) · **now** (fix in
the current polish pass) · **defer** (future release) · **done**.

Size: S (<30min) · M (a focused story) · L (multi-story / new subsystem).

---

## A · Sidebar & projects — walked 2026-07-23

Functional result: **A1–A9 all pass.** Enhancements found:

| ID | Item | Size | Status |
|----|------|------|--------|
| A1-a | **Command-K style project picker.** Replace the plain folder dialog with a keyboard-navigable palette (↑↓ navigate · Enter select · Backspace back · Esc close), matching t3-code's "Sources" sheet. | M | backlog |
| A1-b | **Remote project sources** — Git URL / GitHub / GitLab / Bitbucket / Azure clone (t3-code's other Sources rows). Real cloning subsystem. | L | defer |
| A8-a | **Close-thread confirmation** — "Are you sure?" dialog before closing a thread. User: nice-to-have. | S | defer |
| A9-a | **Hover-to-reveal new-chat icon** on project rows — currently always shown; t3-code only shows it on project hover. | S | backlog |
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
| C9-a | **Pointer cursor on hover** for the send AND stop buttons (`cursor-pointer`). | S | backlog |
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
| F1-a | **Center the ticks** in the rail (currently left-aligned; t3-code centers them for a cleaner spine). | S | backlog |
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
