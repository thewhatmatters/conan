# PRD — image-input backend seam + context-window default fix

_Drafted 2026-07-24. A **backend-only** round designed to be handed to Codex
(or any sandboxed agent that can't bind localhost ports for browser QA). Every
story is verifiable by unit tests / curl / fixtures — NO browser. Builds on
`main`'s chat-primary, multi-provider Conan._

## Why this shape

Two deferred items from `docs/ui-improvements-backlog.md`:

- **#3 context-window "Default model" resolves to 200k, not the real 1M** (S).
- **#1 image paste** (L) — but paste itself is a UI/browser feature. Its
  *backend* — a per-provider image-input capability, driver plumbing, and
  server-side staging — is pure seam work that unit-tests cleanly.

This round is **only** those backend/seam pieces. The browser-facing halves
(the paste handler, transcript image rendering, retiring the paperclip, and the
unified provider/model picker #2) are a SEPARATE follow-up round owned by Claude
— they need `automate-browser`, which a port-binding sandbox can't run. Keeping
them out means this round's `run-tasks.sh` reaches all-pass cleanly instead of
stalling on a browser story.

## Locked constraints (carried from every prior round)

- **No provider-name branching.** New per-provider behaviour rides
  `AgentCapabilities`, like `permissionModes` / `effortModes` / `modelSelection`.
- **Never render/claim a capability a provider lacks.** If a provider can't take
  images, `imageInput` is false and nothing downstream pretends otherwise.
- **Never fabricate.** Unknown context window → null (counts only), never a
  guessed denominator.
- Subscription auth only; no `ANTHROPIC_API_KEY`. Paywall stays off — no gates.
- **UI mirror types via the type-only re-export from `src/agent/driver.ts`**
  (import-free) so drift is a compile error, never a hand-copy.

## Feature A — context-window default fix (#3)

**Problem.** The meter's denominator is `contextWindowFor(provider, launchModel)`.
On a fresh Claude thread the launch model is undefined → the registry's
`default` = 200k — but Claude actually runs `claude-fable-5` (1M). So the ring
shows a 200k denominator on a 1M session.

**Fix.** Resolve the window from the model the **system-init event reports**
(`e.model`), not the launch model. The gateway already sees `e.model` at
session start; recompute `contextWindowFor(provider, e.model)` there and get the
corrected value to the client (refresh the capabilities frame, or add
`contextWindowTokens` to the system event). Unknown reported model → null
(counts only) — never a guess. Verifiable by a unit test on `contextWindowFor`
+ asserting the emitted frame.

## Feature B — image-input backend seam (#1 backend)

**Verified surfaces (flag-level; exact shapes are the probe story's job):**

| Provider | Image input | Shape to pin |
|---|---|---|
| Claude | `image` content block in `--input-format stream-json` user message | base64 block format |
| Codex | `-i/--image <FILE>...` — **initial prompt only**, path-based | temp-file path; multi-image; resumed-turn limitation |
| Grok | `--prompt-json` content blocks (single-turn) | image block shape, or **unsupported** → `imageInput: false` |

**The staging problem.** The browser (a WKWebView) hands over a pasted image as
base64. Codex needs a **file path**, so the gateway must write the bytes to a
temp file and pass its path; Claude wants the base64 inline. So staging is
per-provider: the gateway accepts base64 once and materializes whatever each
driver needs. Bound it (max bytes, max count) like the file-pin path.

**No behaviour change for existing turns** — image plumbing is additive; a turn
with no images serializes exactly as today.

## Out of scope (Claude's follow-up round)

- The composer **paste handler** (`clipboardData.files → image/*`), pending
  image chips, transcript image rendering, retiring the paperclip.
- The **unified provider+model picker** (#2).
- Anything needing `automate-browser`.

## Risks

| Risk | Mitigation |
|---|---|
| Claude/Grok image block shapes are assumed | Probe story pins them against a real image before any driver code; record UNKNOWN honestly. |
| Codex `-i` is initial-prompt-only | Document the limitation; images attach to the turn that spawns the process. A resumed codex turn is a fresh process anyway. |
| Grok may not accept images headlessly | `imageInput: false` for grok is an acceptable, honest outcome. |
| Image plumbing regresses working text drivers | Additive only; parser/serialize tests over existing fixtures stay green. |
| Staging writes temp files | Bounded size/count; cleaned up; token-gated route; path validated. |

## Story outline (all Codex-ownable, no browser)

1. Context-window default fix — resolve from the reported model (Feature A).
2. Facts-first: probe + pin the per-provider image mechanisms as a doc + fixtures.
3. `imageInput` capability + `AgentImageAttachment` on the turn seam + Claude
   descriptor; UI mirror via type-only re-export (no behaviour change).
4. Server-side image staging: a bounded, token-gated path that accepts base64
   and materializes per-provider needs (temp file for path-based CLIs).
5. CodexDriver image plumbing (`-i` with staged paths).
6. ClaudeDriver image plumbing (stream-json image content block).
7. GrokDriver image plumbing (`--prompt-json`) OR honest `imageInput: false`.
