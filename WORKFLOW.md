# WORKFLOW.md — Conan team workflow

Operational rules for how Randy, Hermes, Booker, Nash, and Barkley move a
Linear ticket from assignment to promotion. Read this before any ticket work;
specific ticket details live in Linear and the handoff message.

## 1. Roles and responsibilities

| Role | Owner | What they do |
|------|-------|--------------|
| **Human owner / final gate** | Randy | Picks tickets, approves scope, does the final human check, and authorizes promotion to `main-v2`. |
| **Coordinator** | Hermes | Single point of assignment, state transitions, handoff quality checks, queue management, and Linear + vault closeout. |
| **Builders** | Booker / Nash | One primary owner per ticket. Build the feature, keep the worktree/branch alive, run the gates, and produce the QA handoff packet. |
| **QA** | Barkley | Independent verification: rerun gates, test acceptance criteria in a real browser, and report findings with severity. |

*Default split:* Booker and Nash own implementation. Barkley owns QA. Nash can also
serve as the verification gate for a ticket, but **no one builds and verifies the
same ticket** — if Nash is the builder, a different agent is the gate.

## 2. Ticket lifecycle

States are ordered. Hermes owns the transitions.

```
Backlog
  → Assigned
    → Implementing
      → Ready for QA
        → QA in progress
          → QA changes requested
          → Ready for owner review
            → Approved
              → Promoted
                → Closed
```

**State meanings**

- **Assigned** — owner and scope are set; acceptance criteria are written.
- **Implementing** — builder is cutting code in a dedicated worktree.
- **Ready for QA** — Hermes has a complete handoff packet (see §5). Barkley does
  **not** start without this.
- **QA in progress** — Barkley is testing.
- **QA changes requested** — Barkley found blocking or non-blocking issues; the
  builder reuses the same worktree and adds a regression test.
- **Ready for owner review** — QA passed; Hermes is asking Randy to check.
- **Approved** — Randy signed off.
- **Promoted** — the feature branch is on `main-v2` and verified.
- **Closed** — Linear is updated, checkpoint note is in the vault, preview
  servers are dead, and the next pick is queued.

## 3. Assignment rules

1. **One owner per ticket.** Give exactly one builder primary ownership unless
   Randy explicitly asks for a deliberate race.
2. **Hermes picks the owner when Randy delegates.** If Randy assigns Hermes
   multiple tickets to staff, Hermes selects the builder (and independent
   verifier, when needed) based on current workload, queue depth, and skill fit,
   then publishes the choice in the channel. Randy can override at any time.
3. **Name both roles.** If the ticket needs an independent verification gate,
   the assignment names both the builder and the verifier.
4. **Hermes produces the acceptance checklist** from the Linear ticket and the
   `prd.json`/`prd-*.md` acceptance criteria before work starts. This checklist
   is the contract for both the builder and QA.
5. **Cite the Linear ID** as `WHA-…` in every channel message about the ticket.
   Hermes syncs the actual Linear status because the agent MCP cannot reach the
   workspace.

## 4. Worktree and branch discipline

- **Source of truth checkout:** `/Users/randydigital/Development/conan` is
  read-only for direct edits. It must stay on a clean `main-v2` matching
  `origin/main-v2`.
- **New worktree per ticket:**
  ```bash
  cd /Users/randydigital/Development/conan
  git worktree add -b work/<WHA-id>-<short-desc> \
    /Users/randydigital/.buzz/.scratch/conan-<WHA-id>
  ```
- **Branch naming:** `work/<WHA-id>-<short-desc>`. Document-only branches may use
  `workflow/<desc>`.
- **Reuse the same worktree for all rework** on the same ticket. Do not cut a
  new worktree because a bug came back.
- **Fresh worktree needs `npm install`** in both root and `ui/` before any
  gates run. If you skip a gate on a fresh tree because modules are missing,
  say so explicitly; do not report it as a failure.
- **Clean up only after promotion is verified.** The worktree and preview are
  the recovery surface until the new `main-v2` tip is confirmed.

## 5. Definition of Ready for QA

A builder is **not** ready for QA until Hermes has this complete package. If
anything is missing, Hermes bounces it back to the builder before Barkley starts.

| Item | Required content |
|------|------------------|
| Linear ID + acceptance criteria | `WHA-…` and the checklist. If the AC was thin, Barkley's written interpretation must be confirmed before deep testing. |
| Branch + worktree path | Exact branch name and the absolute path on disk. |
| Exact SHA | `git rev-parse HEAD` from the same shell where the gates ran. |
| What changed | Files/areas touched, not a novel. |
| Automated gates | All green at the reported SHA: command lines, full package pass counts, typecheck, build. A scoped module run is not enough. |
| Manual verify steps | Numbered steps + expected results for the human check. |
| Preview URL | The exact URL Barkley and Randy will use, plus how it was started. |
| Environment notes | Gateway port, UI port, `CONAN_DATA_DIR`, how to enable v2 at this origin (`localStorage.conan-v2` is authoritative; `VITE_CONAN_V2` is only a fallback). |
| Known limits | Out-of-scope, unit-only coverage, or anything not exercised. |
| Regression tests | For any prior bug this work claims to fix, include a test that would have failed before the fix. |
| Fixtures / test assets | Either committed test assets or the fixture steps included verbatim in the handoff. Untracked scratch files do not count as reproducible. |

## 6. Build and preview contract

A preview URL is not enough. The builder must prove the preview is
rendered-browser ready.

### Automated gates before handoff

```bash
npm run typecheck           # gateway, must be clean
cd ui && npm run build      # UI, must be clean
npm test                    # root suite if applicable
```

For UI stories, also drive the app in a real browser (`automate-browser` or
Playwright) with screenshots. **Typecheck + build is not enough for UI work.**

### Gateway / UI footguns

- Run the gateway with `npm start`, not `npm run dev` (the watch restarts and
  can mask a stale process).
- To restart the gateway, use `pkill -f "gateway/index.ts"`. Do **not** use
  `pkill -f "tsx src/gateway"` — it matches nothing and leaves a stale gateway
  silently serving old routes.
- After **any** dependency change, run `rm -rf node_modules/.vite` before
  starting Vite again. The stale cache makes `resolve.dedupe` for `react` and
  `react-dom` not re-apply and causes "Invalid hook call — more than one copy of
  React."
- After restarting the gateway, verify **both** `:3747` and `:5173` are alive.
  Vite can drop silently while the gateway looks fine.
- The gateway has **no watch**. If a fix changes both gateway and UI code, the
  handoff must state: *"gateway process restarted since the last gateway-side
  change."* A browser refresh will not serve the new server code.

### Preview must expose

- The correct feature flag / v2 toggle at the origin being tested.
- The correct gateway port and UI port.
- The correct `CONAN_DATA_DIR` and fixtures.
- The right fonts, assets, and runtime with zero console exceptions.
- A launchd-backed process (or a tracked, non-orphan process). Use an
  `<agent>-` prefix on every label/port so orphan servers are attributable.
- A fresh cache-disabled browser check by the builder before handoff.

The preview stays up through Barkley **and** Randy. It is killed only after the
promotion is verified. If the preview dies mid-loop, the builder restarts it and
re-states the URL.

## 7. QA process

Barkley performs **independent** QA.

1. **Rerun the builder's supplied automated gates** at the reported SHA and
   confirm the pass counts match.
2. **Run the manual acceptance checklist** in a fresh browser at desktop and
   mobile widths.
3. **Adversarial pass:** narrow widths, keyboard/screen-reader, error paths,
   empty/loading states, and the thing the builder did not mention.
4. **Findings format:** severity + one-line why + evidence.
   - **S1 — verified broken:** blocks promote by default.
   - **S2 — suspected / risky:** needs Randy's call; may ship with a tracked
     follow-up.
   - **S3 — polish / untested:** noted but does not block unless Randy says so.
5. **Barkley does not self-pick.** Hermes prioritizes the queue based on Linear
   priority or Randy's call.
6. **Barkley files bugs; he does not patch product code.** Only Hermes may ask for
   a trivial test-blocking fix.
7. **Regression test check:** if the ticket claims to fix a prior bug, verify
   the new test would have failed before the fix.

## 8. Rework loop

When QA or Randy rejects work:

1. The **original builder** reuses the same worktree and branch.
2. The builder adds a **regression test** that would have failed before the fix.
3. Re-QA checks both the fix and the regression test.
4. **Two-round cap:** if the same defect survives two rounds of rework, change
   approach instead of re-swinging.

## 9. Human approval and promotion

### Randy's final gate

Hermes presents a promotion packet:

- Feature SHA and branch.
- Full gate evidence (commands + pass counts + typecheck + build).
- Barkley's QA verdict and severity summary.
- Preview URL and how it was started.
- Known limitations and tracked follow-ups.
- Required commit trailers are present.

Randy approves only when satisfied. **No fast-forward to `main-v2` without
Randy approval.**

### Promotion steps

1. Rebase the feature branch onto the current `main-v2` tip.
2. Rerun the **full affected-package suite** plus repository gates at the
   rebased SHA. If the SHA changes, the previous QA approval is invalid until
   the delta is rechecked.
3. Confirm the required trailers are in place:
   - `Signed-off-by: thewhatmatters <randy@whatmatters.so>`
   - `Co-authored-by: thewhatmatters <randy@whatmatters.so>`
4. Fast-forward `main-v2` to the verified feature SHA. No force-push.
5. Verify the remote refs and the checkpoint tag match the new tip.
6. **Only then** kill the preview servers and clean up the worktree.
7. Push the checkpoint tag and update Linear.

## 10. Closeout

After promotion is verified:

1. **Linear:** mark the issue closed and add a comment with:
   - promoted SHA
   - checkpoint tag
   - test evidence
   - vault checkpoint path
   - confirmation that preview processes and worktrees were cleaned up
2. **Vault checkpoint note** must include:
   - what changed
   - files touched
   - tests run and results
   - verification evidence (preview URLs, screenshots, commands)
   - commit / tag references
3. **Next pick:** Hermes reviews open Linear tickets and coordinates with Randy on
   what to tackle / assign next.

## 11. Concurrency ledger

Hermes keeps a running ledger:

```
ticket → implementer → worktree → branch → gateway port → UI port → preview URL → current SHA
```

This prevents port collisions, duplicate worktrees, and stale previews. Every
preview URL and port must be attributable to an agent and a ticket.

## 12. Handoff template

Builders paste this into the channel when the ticket is **Ready for QA**:

```text
WHA-___ — Ready for QA

Branch: work/wha-___-...
Worktree: /Users/randydigital/.buzz/.scratch/conan-___
SHA: <git rev-parse HEAD>

What changed:
- <files/areas>

Automated gates (all green at SHA above):
- npm run typecheck: <pass/fail + count>
- cd ui && npm run build: <pass/fail>
- npm test: <pass/fail + count>
- <UI browser check>: <result>

Manual verify steps:
1. <step> → <expected result>
2. <step> → <expected result>

Preview URL: <url>
Started with: <command>
Env: gateway :<port>, UI :<port>, CONAN_DATA_DIR=<dir>, v2 toggle: <how>

Known limits:
- <out of scope / not exercised>

Regression tests:
- <test for prior bug, or N/A>
```

## 13. Environment notes

- **macOS runtime:** use the Node version that matches the repo `engines` field.
  On the Mac mini, `nvm 22.14.0`. On the laptop, put `~/.local/bin` first in
  `PATH` because the Homebrew v26 Node violates `engines`.
- **Linear sync:** Nash's Linear MCP cannot reach the workspace. Agents cite
  `WHA-…` IDs in-channel; Hermes performs the actual Linear sync.

## 14. Related files

- `CLAUDE.md` — architecture, stack, and local run/QA details.
- `AGENTS.md` — same essentials for non-Claude agents.
- `prd.json` / `prd-*.md` — current round stories and acceptance criteria.
- `docs/v2-astryx-redesign.md` — v2-only Astryx runbook and design contracts.
