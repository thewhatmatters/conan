# Chat-domain refactor — independent review synthesis (2026-08-03)

**Target:** `main-v2` @ `655181e`  
**Report:** `docs/chat-domain-refactor-2026-08-03.md`  
**Reviewers:** Booker (Section 1), Barkley (Section 2), Nash (Sections 3–4)

## Round closure — 2026-08-03

Sprint 1 items **WHA-96**, **WHA-97**, and **WHA-98** were merged to `main-v2` via fast-forward:

| Ticket | PR | Merge commit | Author | Independent QA |
|---|---|---|---|---|
| WHA-96 | #14 | `80f3eae` | Nash | Booker |
| WHA-97 | #12 | `5223b27` | Barkley | Booker |
| WHA-98 | #13 | `d396238` | Booker | Nash |

**Checkpoint tag:** `checkpoint/v2-wha-96-97-98` @ `80f3eae77cb0536f831d5bb36e87a29b15829ba4`  
**`main-v2` HEAD:** `80f3eae77cb0536f831d5bb36e87a29b15829ba4`

All gates were re-verified by independent QA before merge. WHA-99 and WHA-100 were already merged earlier in the day; WHA-101 is unblocked and merged separately below.

## Round closure — WHA-101 (2026-08-03)

Sprint 1 item **WHA-101** was merged to `main-v2` via fast-forward:

| Ticket | PR | Merge commit | Author | Independent QA |
|---|---|---|---|---|
| WHA-101 | #15 | `ade3d245` | Barkley | Nash |

**Checkpoint tag:** `checkpoint/v2-wha-101` @ `ade3d245942c9d3f09f3ff761338facf8f982964`  
**`main-v2` HEAD:** `da2b808` (plan update after the code merge; tag remains on the merge commit `ade3d245`)

All gates were re-verified by independent QA before merge.

## Overall verdict

The refactor is structurally sound. The transcript fold is a pure reducer, the chat domain model is consolidated, and the `ProviderId` union now catches provider-drift errors at compile time. All three reviewers rate **migration risk as low** for existing code; the v2 aliases remain compatibility names and do not need a migration.

The gaps are small, actionable, and mostly about tightening the new seams (tests, type narrowing, v1 bypasses) and correcting the sizing of one queued item.

---

## Section 1 — reducer contract and test coverage (Booker)

| Verdict | Detail |
|---|---|
| Correctness | Extraction is pure, deterministic, StrictMode-safe, and preserves the public `AgentChat` contract. |
| Gap | `connection-lost` clears `pendingApprovals` but does **not** mark the matching transcript entries as dismissed (`reducer.ts:221–231`). The UI can show a stuck pending-approval line next to the terminal connection-loss error. This predates the refactor, but the reducer is now the right place to fix it. |
| Coverage | 29 reducer tests cover every action/event family. Add one assertion to the disconnect test (`reducer.test.ts:271–289`) that the transcript entries are dismissed. |
| Migration risk | Low. `ChatItem`/`PendingApproval`/`SentPin`/`SentImage` remain re-exported from `useAgentChat`, and all call sites still compile. |

---

## Section 2 — domain model consolidation and provider union seam (Barkley)

| Verdict | Detail |
|---|---|
| Correctness | Consolidation is real; the `kimi` glyph fix is structural via `asProviderId` + `PROVIDER_ID_SET`. |
| Gaps | 1. The report slightly overstates compiler coverage for a new provider: extending `ProviderId` forces `PROVIDER_ID_SET` and `CONTEXT_WINDOWS`, but does **not** force `PROVIDERS[]`, `PROVIDER_ICON` keys, driver/history modules, or `AgentDriver.provider` (still `string`). 2. `asProviderId` maps any non-union / null value to `"claude"` — correct for pre-migration nulls, but still silent for typos. 3. v1 bypasses the narrower union: `ChatPane.tsx` and `ChatSurface.agentOf` use `resume.provider ?? "claude"` instead of `asProviderId`. 4. `HistoryItem` is declared in both gateway `src/agent/history.ts` and UI `model.ts` (structurally compatible, not single source of truth). 5. No direct unit tests for `asProviderId` or set completeness. |
| Follow-ups (in order) | 1. Type `PROVIDER_ICON` as `Record<ProviderId, string>` (or `Partial` + explicit fallback). 2. Add a test asserting `PROVIDERS.map(p => p.id)` equals `PROVIDER_IDS`. 3. Route v1 `ChatPane`/`ChatSurface` through `asProviderId`. 4. Add table tests for `asProviderId` (include `kimi`). 5. Optionally type `AgentDriver.provider` as `ProviderId`. 6. Later, unify `HistoryItem` if the import graph allows. |
| Migration risk | Low while v2 aliases (`V2Project`, `V2SavedThread`, `V2Provider`, `ThreadProvider`, `V2ThreadUiState`) stay pure aliases. Real risk is re-declaring a local interface or adding fields only to an alias, which is the failure mode that caused the `kimi` drop. |
| Queued sizing | Capabilities re-send is **small, high-leverage**. `useV2Chat` dropped fields is **medium–large**. Larger candidates are correctly deferred. |

---

## Sections 3–4 — live bugs and queued work (Nash)

### Verification
- UI: **237/237** tests across 28 files, typecheck clean.
- Gateway: **213/213** tests, typecheck clean.
- All checks run at `655181e` in the same shell as the review.

### Section 3 — live bugs fixed

| Claim | Verdict |
|---|---|
| v2 `kimi` coercion | Confirmed. `asProviderId` narrows through `PROVIDER_ID_SET`, so a dropped provider is now a compile error. |
| v1 effort-chip no-op | Fix is correct (`ChatPane.tsx:714–719`), but it is **untested** because v1 components have no specs. The durable fix is to extract the launch-opts assembly into a pure `buildLaunchOpts()` under `ui/src/chat/` and table-test it. Size **S**. |
| StrictMode "Session started" drop | Confirmed structurally and covered: `reducer.test.ts:47` asserts a same-id re-init adds no second system line. |

### Section 4.1 — `useV2Chat` dropped fields

The report mis-states the symptom and understates the bug:

- The session **does** leave plan mode when the user approves `ExitPlanMode` (`claude.ts:364–369`). v2 never learns it because `useV2Chat` drops `permissionMode`.
- The bigger bug is that the v2 permission chip is a **silent no-op after turn 1**: `V2Composer.tsx:103` keeps the mode in local state and only sends it in the prompt frame, while `ClaudeDriver.send()` fixes the launch config on the first prompt. The live update path is the `set-permission-mode` frame (`src/agent/index.ts:279–287`), which v1 uses (`ChatPane.tsx:756–759`) but v2 cannot because `setPermissionMode` is dropped.

**Sizing correction:** this is two tickets, not one.
- **4.1a — S, ship first:** restore the 5 pass-throughs in `useV2Chat` (~10 lines), wire the chip to a v1-style `applyPermission`, and make the chip follow live mode. Fixes both the "no-op" and the "lying indicator".
- **4.1b — M:** build a v2 context meter. `contextTokens` is a hook field, but v2 has no meter component at all; v1's `ContextMeter` is a private function inside `ChatPane.tsx:1912`. This is new v2 UI, not a simple restore.

### Section 4.2 — capabilities re-send

The report's rule is correct, but its framing omits why the re-send exists and which providers are affected.

- **It is a deliberate fix, not a regression.** Launch caps go out at driver build (`index.ts:185–189`), the first `system` event re-sends with the reported model (`index.ts:87–95`), and the reducer replaces `capabilities` wholesale (`reducer.ts:166–167`). The stale header comment at `index.ts:54–56` still says caps are "sent once … never re-sent".
- **Claude is the point, not collateral damage.** `docs/multi-provider-qa.md:88` records that Claude reports `claude-fable-5`, which is in `CONTEXT_WINDOWS` → the re-send upgrades the ring from 200k to 1M. Deleting the re-send silently re-opens the still-open backlog item at `docs/ui-improvements-backlog.md:235–250`.
- **Real regressions are grok and kimi.** Grok's `modelUsage` key is `grok-4.5-build`, not in `CONTEXT_WINDOWS.grok` → null. Kimi reports `null` always (`kimi.ts:285`), losing its 1M default. Codex only regresses when a model chip is selected; on "Default model" it is already null because `CONTEXT_WINDOWS.codex` has no `default` key.
- **There is a test in the way.** `src/agent/registry.test.ts:62–82` pins today's nulling at the registry level. Implement the rule in `src/agent/index.ts` (hold launch caps in a closure, let a reported model only *raise* a non-null window) so the registry test stays honest, and add an index-level test.

**Sizing correction:** **XS** — one closure variable + `??` plus one test. This is the smallest, highest-leverage item in the queue and should ship before 4.1.

### Migration risk (Nash)

None. `AgentChat`'s public surface is unchanged — all 13 members are still exported from `useAgentChat.ts:97–143`. `useV2Chat` is the only consumer that narrows the shape, so the pass-through work is purely additive.

---

## Recommended next steps (ordered by leverage)

1. **4.2 capabilities re-send** — XS, in `src/agent/index.ts` (not registry). Preserve launch caps; let reported model only refine upward; update the stale header comment; note the claude upgrade rationale. This fixes a user-visible meter and avoids re-opening the backlog item.
2. **4.1a v2 permission-mode pass-throughs** — S, in `useV2Chat` + `V2Composer`. Restores live mode updates and stops the chip from lying.
3. **Section 3 effort-chip durable fix** — S, extract `buildLaunchOpts()` in `ui/src/chat/` and table-test it. Closes the untested v1 gap that caused the bug.
4. **Section 1 reducer dismissal** — S, add transcript dismissal on `connection-lost` and a regression test.
5. **Section 2 provider-seam tightening** — small follow-ups: `PROVIDER_ICON` typing, set-equality test, route v1 through `asProviderId`, table tests for `asProviderId`. Optional: type `AgentDriver.provider` as `ProviderId`.
6. **4.1b v2 context meter** — M, net-new UI component.
7. **Deferred** — larger candidates: shared turn-process runtime behind the driver seam, typed WS frames, unified thread-history module, remaining v2 pass-through deletions.

---

## Created tickets (2026-08-03)

All assigned to you (Randy) in Linear. **Sprint placement (Conan Sprint 1, Aug 3–9):** WHA-96 → WHA-100 → WHA-101 were in the sprint. **All six are now merged to `main-v2`.**

|| Ticket | Owner | Size | Story | Status |
|---|---|---|---|---|---|---|
|| [WHA-96](https://linear.app/whatmatters/issue/WHA-96/xs-capabilities-re-send-preserve-launch-window-only-refine-with) | Codex / backend agent | XS | Capabilities re-send guard (`src/agent/index.ts`) | **Merged** #14 @ `80f3eae` |
|| [WHA-97](https://linear.app/whatmatters/issue/WHA-97/s-restore-v2-permission-mode-pass-throughs-and-wire-live-mode) | Claude / UI agent | S | v2 permission-mode pass-throughs | **Merged** #12 @ `80f3eae` |
|| [WHA-98](https://linear.app/whatmatters/issue/WHA-98/s-extract-v1-composer-launch-opts-into-buildlaunchopts-and-table-test) | Claude / UI agent | S | `buildLaunchOpts()` extraction + table tests | **Merged** #13 @ `80f3eae` |
|| [WHA-99](https://linear.app/whatmatters/issue/WHA-99/s-reducer-dismiss-pending-approval-transcript-entries-on-connection) | Claude / UI agent | S | Reducer connection-lost dismissal + test | **Merged** #10 @ `49f51b5` |
|| [WHA-100](https://linear.app/whatmatters/issue/WHA-100/s-tighten-provider-union-seam-icon-typing-set-equality-v1-routing-and) | Claude / UI agent | S | Provider-seam type tightening + v1 `asProviderId` routing | **Merged** #11 @ `5a14ddf` |
|| [WHA-101](https://linear.app/whatmatters/issue/WHA-101/m-build-v2-context-meter-component) | Claude / UI agent | M | v2 context meter | **Merged** #15 @ `ade3d245` |


---

## Source notes

- Booker review: thread reply @ `655181e`.
- Barkley review: thread reply @ `655181e`.
- Nash review: thread reply @ `655181e`, with verification evidence (`git rev-parse HEAD`, UI 237/237, gateway 213/213).
- Auditor report: `docs/chat-domain-refactor-2026-08-03.md`.
