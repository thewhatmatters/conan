# Conan Setup — design doc (`conan` spec-first onboarding)

_Status: **v1 fully specced, not yet built** · Decided 2026-06-16 · Owner: Randy_

A guided, **spec-first project setup** that runs when Conan opens — Conan's
`create-next-app` moment, but the payload is *thinking*, not a framework picker.
The user is walked through a chosen **Method** (a thinking/scaffolding
framework) and handed off to a Claude Code session that's already primed to do
the right thing.

Grounded in Andrej Karpathy's method as distilled in
[docs/sources/stop-prompting-claude-use-karpathy-s-method-instead.md](sources/stop-prompting-claude-use-karpathy-s-method-instead.md)
— the 3 layers **spec → verifier → environment**, "interview me to find the
goal", agile/compartmentalized specs, "verify key decisions explicitly", and the
north star: _"You can outsource your thinking, but you can't outsource your
understanding."_

---

## 1. Why this exists

Conan wraps and **observes** Claude Code. Today, opening Conan drops you at a raw
`claude` prompt — nothing helps you start a project *well*, and nothing produces
the artifact Conan was built to watch. Conan already has a build-loop Timeline
(BUILD rows from `prd.json`/`progress.txt`) and a `/api/tasks` endpoint waiting
for that artifact, but nothing in Conan *produces* it.

Setup closes the loop:

```
conan setup → produces PRD.md / prd.json / CLAUDE.md
            → build loop runs
            → Conan's HUD + Timeline observe it happening
```

It's also a **free top-of-funnel activation hook**: it gets a brand-new user to
a real spec or a primed workspace in minutes, demonstrates Conan's value, and
pushes them toward the build loop that the Premium insight layer observes.

## 2. Core model — a menu shell over a Methods registry

Setup is **not** a single linear flow. It's a **branded menu shell** over a
**data-driven Methods registry**. A **Method** is a thinking/scaffolding
framework, and crucially **each Method is implemented as a reusable Claude Code
skill** — Conan only renders the menu and invokes the chosen skill.

```
conan
  ⚔  CONAN — Karpathy setup

  How do you want to start?
  › Methods            → ┌ Karpathy   (faithful 3-layer spec interview → PRD.md)
    Create a Method      │ conan      (route pick → CLAUDE.md/DESIGN.md → hand off)
    Start Claude instead └ (your own…)
```

- **Methods** → submenu of available frameworks.
- **Create a Method** → author your own. A Method *is* a skill, so this is
  "scaffold a skill" (would lean on `generate-skill`). On-brand with Karpathy's
  Layer 3 — _"if you do something repeatedly, make a skill."_ **v1: shown in the
  menu but inert ("coming soon"); built later.**
- **Start Claude instead** → escape hatch straight to the normal pty.

### Why a registry of skills (not a hard-coded TUI)
- The "interview me" magic only works if there's a **real interviewer** — that's
  Claude, not a static menu. Conan's native job is tiny: splash + menu + detect +
  invoke.
- A method = `{ name, description, skill, detects? }`. Adding a method (or a user
  authoring one) is a **registry entry**, not a menu rewrite.
- Methods compose with skills that already exist: `generate-prd`,
  `decompose-prd`, `craft-claude`, `design-md`, `generate-skill`.

### Trigger & tier (decided)
- **Trigger: AUTO-RUN** the menu on launch. The **"Start Claude instead"** entry
  is what keeps auto-run from being annoying — anyone who just wants a terminal
  exits in one keystroke. (No separate first-launch-only gating.)
- **Tier: FREE**, end to end. It's the activation hook; gating it would lose the
  funnel.

## 3. Stage 0 — Detect & branch (Conan native)

The only substantial native piece. On launch:

1. Render the branded splash + menu.
2. Detect project context — **empty/new dir vs existing codebase with source
   files** (cf. the MEX "Detected: existing codebase → populate from code"
   pattern). Methods receive this so they can adapt ("spec from scratch" vs
   "populate from code").
3. On selection, invoke the chosen Method's **skill** in the live pty (Conan
   already injects slash commands / keystrokes into the correlated pty — same
   mechanism as `/context`, `/usage`, `/handoff`).

Everything past Stage 0 is **Claude-driven**, inside the skill.

## 4. The Karpathy method (v1 = Stages 1–4 → `PRD.md` + `CLAUDE.md`)

> **Evolution (2026-07-03, decided during the conan-cli v0 build):** after the
> first real interview, a Stage 4 was added — author `CLAUDE.md` **from the
> locked PRD** (embedded template, `craft-claude` optional-only, never
> overwrites, declinable). Rationale: a CLAUDE.md distilled from a
> just-verified spec beats one from a cold interview. This narrows the
> two-method split below from *output type* to *depth* — the conan method
> remains the light one-pass environment scaffold. Implementation canon:
> `conan-cli/docs/prd-conan-cli.md`.

The faithful, thorough flow. Deliberate, multi-checkpoint — for projects where
the stakes justify the rounds. Maps 1:1 to Karpathy's Layer 1.

- **Stage 1 · Excavate the goal** (Layer 1.1) — Claude **interviews** the user
  for the *goal/decision the work drives* (not the task), the audience, the
  definition of done, and explicit out-of-scope. The information only the human
  can supply.
- **Stage 2 · Draft the spec, agile** (Layer 1.2) — a **small, compartmentalized**
  spec (not one waterfall blob) → **`PRD.md`** (via `generate-prd`).
- **Stage 3 · Verify key decisions** (Layer 1.3) — Claude surfaces its
  **assumptions and key decisions** and the user **confirms each explicitly**
  before anything locks. The "use your brain" gate.

**v1 ends at a reviewed `PRD.md` + a `CLAUDE.md` authored from it (Stage 4,
declinable).** Stages are **exit-able / resumable** — agile
means you can stop after the spec and just build.

_Deferred to later versions (Karpathy Layers 2–3, the full method):_
- **Stage 4 · Verifier** (Layer 2) — eval criteria up front, second-model critic
  (e.g. Codex plugin), external-signal verification (deploy checks, reference
  docs).
- **Stage 5 · Environment** (Layer 3) — `CLAUDE.md` + LLM knowledge base +
  always-do/ask-first/never-do guardrails as **PreToolUse hooks**.
- **Stage 6 · Decompose → build** — `decompose-prd` → **`prd.json`** → build
  loop, which Conan's Timeline BUILD rows already observe. _This is the step that
  literally closes the loop in §1._

## 5. The conan method (v1 = route pick → docs → hand off)

The house **environment scaffolder** — light and fast. Different *output* from
Karpathy, not just a faster version of it.

1. **Route pick** — the user chooses a project archetype (see §6).
2. **Light, one-pass interview** — roughly a single screen: _"In a sentence or
   two: what are you building, who's it for, the one outcome that matters, and
   what's explicitly out of scope?"_
3. **Scaffold the workspace (DOCS ONLY in v1):**
   - **`CLAUDE.md`** — always (via `craft-claude`), tuned by the route.
   - **`DESIGN.md`** — only on UI routes (via `design-md`).
4. **Hand off** — launch a fresh `claude` session in the dir. The hand-off is
   **~free**: Claude Code auto-loads `CLAUDE.md` on session start, so the new
   session "just knows what to do." conan's whole job is to make those docs
   *good*, fast.

**Docs-only (v1):** conan writes the **context docs**, NOT real project
files/folders/deps. The handed-off Claude session builds the actual structure
*from* the docs. This keeps conan light and avoids Conan owning a pile of
per-stack templates. Real file scaffolding is a possible fast-follow.

### Output split (the clean differentiator)
| Method | Interview | Output | Answers |
|---|---|---|---|
| **Karpathy** | Deep, multi-round | `PRD.md` | *what & why* (the plan) |
| **conan** | Light, one-pass | `CLAUDE.md` (+ `DESIGN.md`) | *the environment* (the workspace) |

Distinct menu choices in v1. Could **chain** later (Karpathy's `PRD.md` → conan's
scaffold).

## 6. conan routes (v1 — tighter starter set)

The route tunes **which sections land in `CLAUDE.md`** and **whether
`DESIGN.md` fires**.

| Route | Scaffolds | DESIGN.md? |
|---|---|---|
| **Web app** | CLAUDE.md (stack, conventions) + DESIGN.md | ✅ |
| **API / backend** | CLAUDE.md (routes, data model, conventions) | — |
| **CLI tool** | CLAUDE.md (command structure, UX) | — |
| **Other / blank** | minimal CLAUDE.md from the interview only | — |

**Web is the only v1 route that fires DESIGN.md.** Fast-follow routes:
full-stack, library/package (public API + semver), content/writing (+ a
`VOICE.md` in place of DESIGN.md).

## 7. v1 scope summary

**In:**
- Native: branded splash + nested menu + new-vs-existing detection + invoke
  selected method's skill (Stage 0).
- Methods registry (data-driven).
- **Karpathy** method skill — Stages 1–4 → `PRD.md` + `CLAUDE.md`
  (Stage 4 added 2026-07-03; see §4 evolution note).
- **conan** method skill — route pick (Web/API/CLI/Other) → CLAUDE.md
  (+ DESIGN.md on Web), docs-only → hand off.
- **Start Claude instead** escape hatch.
- Auto-run on launch; free for everyone.

**Listed but inert in v1:** Create a Method.

**Out (fast-follows / later versions):** Karpathy Stages 4–6 (verifier,
environment, decompose→build), real file/folder scaffolding, additional conan
routes, functional "Create a Method", method chaining.

## 8. Open questions / TBD

- **Skill names** — e.g. `karpathy-spec` and `conan-scaffold`? Naming TBD.
- **Resumability mechanics** — how a half-finished method is detected and
  resumed on next launch (write artifacts incrementally; detect partial state).
- **Splash / menu visual** — the branded Stage-0 UI (TUI in the pty? native UI
  panel? leaning pty-rendered for the "command" feel).
- **"Populate from code" depth** — how much an existing-codebase run reads before
  interviewing.
- **Create a Method** — full design when it's built (likely `generate-skill` +
  a registry-entry step).

## 9. References
- Karpathy method source:
  [docs/sources/stop-prompting-claude-use-karpathy-s-method-instead.md](sources/stop-prompting-claude-use-karpathy-s-method-instead.md)
- Persistent memory: `project_conan_karpathy_setup` (decision log).
- Composes with skills: `generate-prd`, `decompose-prd`, `craft-claude`,
  `design-md`, `generate-skill`.
- Build-loop / Timeline observability: see CLAUDE.md (`/api/tasks`, BUILD rows).
