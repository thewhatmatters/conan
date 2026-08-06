# Conan Fleet Phase 0 Freeze

> Status: draft — pending Randy approval of defaults / product forks.  
> Owner: Hermes (architecture review + ADR drafting).  
> Source: #ideas thread `5b12360a…` and review passes by Booker, Nash, Barkley.

This document freezes the load-bearing decisions for the first fleet/lineage vertical slice. The goal is to stop re-arguing semantics while the schema and dispatcher are being built. Code for Phases 1–4 references this ADR as the contract.

## 1. Invariants

### 1.1 Single dispatcher

All agent process spawns — interactive chat **and** fleet attempts — go through one dispatcher wrapping the existing `provider.createDriver` seam (`src/agent/index.ts`). There is no second spawn entry point in the gateway or agent modules. The dispatcher owns only enforceable predicates; provider/model optimization and workflow choreography come later.

### 1.2 Dispatch context discriminant

The dispatcher accepts a `DispatchContext`:

- `chat` — ordinary interactive turns. No ticket, no AC, no builder/verifier pair, no round counter. Enforced fleet predicates are skipped.
- `fleet-attempt` — a task attempt under lineage. All fleet predicates run.

This is one seam with two policies, not two doors.

## 2. Containment semantics

Containment is resolved at spawn time from `(provider, permission_mode)` and recorded both as a column on the attempt row (`containment_observed`) and as observed mode-change events for mid-attempt widening. The classes are not totally ordered; a role floor is an explicit allowed-set.

| Class | Meaning | Examples |
|---|---|---|
| `none` | No approval channel and permission flags rejected; every tool runs. | kimi headless `-p` (`danger-full-access` on every session) |
| `prompt-gated` | Approvals route to a human via the control channel; tools the user's `settings.json` already allows never prompt. | claude default supervised mode |
| `fail-closed-cancel` | No approval channel exists; anything needing approval cancels the turn. Tools inside the allowlist still run. | grok `default` (unknown modes floor here) |
| `os-sandbox` | Kernel-enforced, fixed at spawn. | codex `--sandbox read-only`, `--sandbox workspace-write` |

Containment floors are per role. A role floor is an explicit set of allowed classes (e.g., `floor: [os-sandbox]` or `floor: [os-sandbox, fail-closed-cancel]`), not a `>=` comparison on a fake total order. A role binding must be in the allowed set or the dispatch is refused.

- **Critic floor:** allowed-set is `{os-sandbox}` with `codex` `sandbox: read-only` explicitly pinned (must not inherit the session's `acceptEdits`/`workspace-write` mode). `unknown` is never acceptable.

## 3. Identity and independent verification

Independent verification means a **fresh runtime instance/principal** that is not the builder.

- Identity is `(principal_id, runtime_instance_id)`, not provider or model alone.
- Same model is allowed.
- Same instance/principal is refused (self-verify ban).

For the first walking skeleton, Nash and Barkley run on the same machine under different principals; this satisfies the rule without cross-machine mechanics.

## 4. Verdict state machine

Canonical transition for artifact critique:

```
NEEDS_EVIDENCE
  → evidence recorded at exact SHA/digest
    → fresh critic attempt (not the builder, not the evidence producer)
      → APPROVED | REVISE | ESCALATE
```

- No approve-by-side-effect. Evidence alone does not promote.
- A fresh critic attempt is required after evidence is recorded.
- `APPROVED` is artifact-class-aware:
  - Read-verifiable artifacts (docs, rubrics) may satisfy acceptance on read.
  - Executable / user-visible artifacts require evidence-backed matching and may require human-eye review (see §6).
- Promote gate cannot clear without admissible evidence per §6.

## 5. Evidence object

Required v1 fields:

| Field | Purpose |
|---|---|
| `evidence_id` | Stable reference |
| `sha` or `digest` | Exact artifact state the evidence applies to |
| `attempt_id` | The attempt that produced the evidence |
| `runner_principal_id` | Who ran the verification |
| `runner_binding_id` | Runtime instance that produced the evidence |
| `harness` | What produced the observation (e.g., `npm test`, `automate-browser`, `playwright`) |
| `observation_method` | How the observation was made (e.g., `exit-code`, `screenshot`, `human-read`) |
| `commands[]` | `cmd`, `cwd`, `exit`, `stdout_digest`, `duration_ms` |
| `recorded_at` | Timestamp |

Verdict bind list must include the evidence producer alongside digest, rubric version, critic model, and attempt id.

## 6. Stale, flake, and admissibility rules

### 6.1 Stale tip

If the branch tip SHA or digest drifts after evidence is recorded, the evidence and any existing `APPROVED` verdict are invalidated. Promote is refused until re-verification.

### 6.2 Flake policy

- At most one automatic re-run.
- Both outcomes are recorded.
- A flaky green is not green.
- Second flake → `ESCALATE` with reason `evidence-unstable`.

### 6.3 Inadmissible automation

Capture-kind evidence (`screenshot`, `byte-identical capture`) for a paint/top-layer / portal UI claim is **inadmissible alone**. The promote gate requires a human-eye review.

## 7. Ticket `qa` block mapping

A ticket's `qa` block maps to the **verify** role, with optional critic. Critic and verify are not merged; `qa` does not silently approve.

## 8. Same-finding threshold

`same_finding_failures` cap is **3**. One integer, enforced as a value-object predicate.

## 9. Phase 1 enforced predicates

The dispatcher and lineage layer enforce these as pure value-object checks with table-driven unit tests (zero model calls):

- AC exists before dispatch.
- Resolved binding + mode meets the role floor.
- Builder principal/instance differs from verifier.
- Round and same-finding caps.

Promote-gate checks live on the promote path, not in the dispatcher. This includes:
- Promote gate cannot clear without admissible evidence per §6.
- Stale digest/SHA invalidates evidence and approval.

## 10. Open product decisions for Randy

Two decisions remain outside the architecture defaults:

1. **Approve the defaults above, or override any?** Silence = accept.
2. **Walking-skeleton ticket:** a real user-visible frontend bug from the open backlog (recommended), or a synthetic "fleet demo" ticket? Real bugs keep the first vertical slice honest; synthetic risks theatre.

## 11. Builder/verifier pairs for the first slice

| Phase | Builder | Verifier | Notes |
|---|---|---|---|
| Phase 0 ADR | Hermes | Barkley (trust semantics), Nash (seam fit), Booker (UI vocab) | Review, not code |
| Phase 1a dispatcher | Nash | Barkley | Same machine, different principals |
| Phase 1b schema | Nash | Barkley | Blocked until this ADR lands |
| Phase 2 trust predicates | Barkley | Nash | Pure value-object tests, zero DB/model |
| Phase 3 UI surface | Booker | Nash or Barkley | Work/Reviews/Needs-you only |
| Phase 4 walking skeleton | Hermes orchestrates | Randy final gate | Real ticket or synthetic per decision #2 |

## 12. References

- Source thread: #ideas `8bd831c2-70dc-41b1-b344-50bfbd7224fb`, event roots `5b12360a…` and `20aee5dd…`.
- Existing seam: `src/agent/index.ts:225–265` (`ensureDriver`), `src/agent/index.ts:77` (`active` live set), `src/gateway/index.ts:74` (`attachAgent` import).
- Codex sandbox pinning: `src/agent/codex.test.ts:235–246` (`sandboxFor("acceptEdits")` → `workspace-write`).
