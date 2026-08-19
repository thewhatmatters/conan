/**
 * WHA-144 (C4) + WHA-232 — the fixed 4-stage pipeline board and denser node
 * card chrome.
 *
 * A HORIZONTAL LAYERED BOARD, not a physics graph (AC1). Sagan's loop is fixed
 * by `.sagan/sagan.yaml` — `rules.ship_requires: [critic_approved,
 * verify_evidence_sha]` plus `gates.promote: per-ticket` — so the stages are
 * Build → Critique → Verify → Promote Gate for every project, always in that
 * order. Nothing here is laid out by force simulation, and nothing is draggable:
 * a stage's x position IS its place in the loop, so the board reads the same way
 * twice and a screenshot of it means something.
 *
 * NODES ARE TASKS (AC2). One card per `SaganRunSummary`. WHA-232 densifies the
 * card to match artboard `51440d38…`: ticket id, optional two-line title, a
 * Status sub-block (from recorded notes / attention kind), attention glyph for
 * `approval`|`blocked`, and a footer role token — no invented durations.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  ArrowRight,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  CircleX,
  GitMerge,
  Hammer,
  Info,
  ListTodo,
  OctagonAlert,
  PlayCircle,
  ScanSearch,
  ShieldCheck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { SaganRunSummary } from "../../../../src/sagan/api.ts";

/** Below this surface width the board is replaced by the Overview list (AC7). */
export const SAGAN_PIPELINE_MIN_WIDTH = 520;

export type SaganStage = "build" | "critique" | "verify" | "promote";

export type SaganNodeState =
  | "queued"
  | "running"
  | "complete"
  | "approval"
  | "blocked"
  | "failed"
  | "skipped";

interface StageSpec {
  id: SaganStage;
  label: string;
  icon: LucideIcon;
  /** Rendered as the column's ordinal — the layer order without relying on
   *  left-to-right reading alone. */
  step: number;
}

export const SAGAN_STAGES: readonly StageSpec[] = [
  { id: "build", label: "Build", icon: Hammer, step: 1 },
  { id: "critique", label: "Critique", icon: ScanSearch, step: 2 },
  { id: "verify", label: "Verify", icon: ShieldCheck, step: 3 },
  { id: "promote", label: "Promote Gate", icon: GitMerge, step: 4 },
];

const has = (value: string, ...needles: string[]): boolean =>
  needles.some((needle) => value.includes(needle));

/**
 * Which of the four stages a run currently sits in.
 *
 * Lanes and phases are OPEN STRINGS in the ledger — `projectLedger` says so
 * outright ("Never an enum"), and the reference ledger at `thewhatmatters/sagan`
 * @ `ab2cb8d` carries `frontend`, `critique`, `verify`, `design` and `done`
 * across its lanes, with a `design` lane that has no role file at all. So the
 * mapping is a heuristic over substrings, resolved in this order — LAST stage
 * first, so a run that has reached the gate is not dragged back by a stale lane:
 *
 *   1. **Promote Gate** — an open decision on a gate named `promote*` (the
 *      human gate `sagan.yaml` declares), or a lane/phase saying the work has
 *      landed: `done`, `merged`, `promote(d)`, `ship`, `release`, `complete`.
 *   2. **Verify** — lane or phase mentions `verify`, `qa` or `test`.
 *   3. **Critique** — lane or phase mentions `critique`, `critic` or `review`.
 *   4. **Build** — EVERYTHING ELSE, including `frontend`, `design`, a null
 *      lane, and any lane a future Sagan build invents. Build is the default
 *      on purpose: an unknown lane is work in progress, and dropping it off the
 *      board entirely would be the one failure mode a pipeline must not have.
 *
 * Note the asymmetry with `openDecisions`: only a PROMOTE gate moves a run's
 * stage. A gate like `art-direction-approval` (also in the reference ledger)
 * fires mid-build and only changes the node's STATE to `approval`.
 */
export function stageFor(run: SaganRunSummary): SaganStage {
  const lane = run.lane?.toLowerCase() ?? "";
  const phase = run.phase?.toLowerCase() ?? "";
  if (run.openDecisions.some((decision) => decision.gate.toLowerCase().includes("promote"))) {
    return "promote";
  }
  if (
    has(lane, "done", "merged", "promote", "ship", "release", "complete") ||
    has(phase, "merged", "promoted", "complete", "done")
  ) {
    return "promote";
  }
  if (has(lane, "verify", "qa", "test") || has(phase, "verify")) return "verify";
  if (has(lane, "critique", "critic", "review") || has(phase, "critique")) return "critique";
  return "build";
}

/**
 * The node's state (AC4). Resolved in this order, first match wins:
 *
 *   - `skipped`  — a lane/phase or ledger flag that says the step was skipped.
 *   - `approval` — `openDecisions.length > 0`, the same Needs-you predicate the
 *     Overview counts on. A human gate outranks whatever the machine last said.
 *   - `failed`   — verdict `ESCALATE` (the circuit-breaker verdict), or a phase
 *     that says failed.
 *   - `blocked`  — verdict `REVISE` / `NEEDS_EVIDENCE`, or a phase mentioning
 *     `block`. The run is alive but cannot advance until someone acts.
 *   - `complete` — lane/phase `done` / `merged` / `complete(d)` / `promoted`.
 *   - `queued`   — the same exact-match vocabulary the Overview's `Up next`
 *     section uses, so a run never reads "Queued" in one tab and "Running" in
 *     the other.
 *   - `running`  — the default: a live lane in a live phase.
 */
export function nodeStateFor(run: SaganRunSummary): SaganNodeState {
  const lane = run.lane?.toLowerCase() ?? "";
  const phase = run.phase?.toLowerCase() ?? "";
  const verdict = run.verdict?.toUpperCase() ?? "";
  if (has(lane, "skip") || has(phase, "skip")) return "skipped";
  if (run.openDecisions.length > 0) return "approval";
  if (verdict === "ESCALATE" || has(phase, "fail")) return "failed";
  if (verdict === "REVISE" || verdict === "NEEDS_EVIDENCE" || has(phase, "block")) return "blocked";
  if (
    ["done", "merged"].includes(lane) ||
    ["done", "merged", "complete", "completed", "promoted"].includes(phase)
  ) {
    return "complete";
  }
  if (["queued", "queue", "backlog"].includes(lane) || ["queued", "backlog", "pending"].includes(phase)) {
    return "queued";
  }
  return "running";
}

/**
 * Every state carries an ICON, a SHAPE and a LABEL (AC4) — colour is the fourth
 * cue, never the only one. The shapes are deliberately coarse enough to read at
 * a glance in greyscale: dashed vs dotted vs solid border, hairline vs heavy,
 * square vs rounded corners, plus a leading rule on the two states that want a
 * human.
 */
const NODE_STATES = {
  queued: { icon: ListTodo, label: "Queued" },
  running: { icon: PlayCircle, label: "Running" },
  complete: { icon: CircleCheck, label: "Complete" },
  approval: { icon: CircleHelp, label: "Awaiting decision" },
  blocked: { icon: OctagonAlert, label: "Blocked" },
  failed: { icon: CircleX, label: "Failed" },
  skipped: { icon: CircleSlash, label: "Skipped" },
} satisfies Record<SaganNodeState, { icon: LucideIcon; label: string }>;

const roleLabel = (run: SaganRunSummary): string | null => {
  const role = run.agent?.role;
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
};

/**
 * Status sub-block copy (WHA-232).
 *
 * - Attention states (`approval`|`blocked`) always show the kind label so the
 *   shared Info glyph is not the only distinguisher.
 * - Any state may also show a recorded `statusNote` from lane/verdict events.
 * - Non-attention states with no note omit the block entirely (never an empty
 *   Status shell).
 */
export function statusBlockFor(
  run: SaganRunSummary,
  state: SaganNodeState,
): { kind: string; note: string | null } | null {
  const kind = NODE_STATES[state].label;
  const note = run.statusNote;
  if (state === "approval" || state === "blocked") return { kind, note };
  if (note) return { kind, note };
  return null;
}

const styles = stylex.create({
  root: { alignItems: "stretch", width: "100%" },
  legend: { color: "var(--conan-text-muted)", flexWrap: "wrap" },
  legendKey: { alignItems: "center", flexShrink: 0 },
  legendLine: {
    borderTopColor: "var(--conan-color-border-strong)",
    borderTopWidth: "var(--conan-border-width)",
    width: "var(--conan-space-6)",
  },
  legendLineSolid: { borderTopStyle: "solid" },
  legendLineDashed: { borderTopStyle: "dashed" },
  board: {
    alignItems: "stretch",
    // Columns scroll internally; the board itself does not become a second
    // vertical scroller (WHA-232 column chrome).
    overflowX: "auto",
    overflowY: "hidden",
    paddingBlockEnd: "var(--conan-space-2)",
    width: "100%",
  },
  column: {
    alignItems: "stretch",
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-md)",
    flexBasis: 0,
    flexGrow: 1,
    flexShrink: 0,
    maxHeight: "32rem",
    minWidth: "13rem",
    overflowY: "auto",
    padding: "var(--conan-space-2)",
  },
  columnHeader: {
    alignItems: "center",
    position: "sticky",
    top: 0,
    zIndex: 1,
    backgroundColor: "var(--conan-wash-raised)",
    paddingBlockEnd: "var(--conan-space-1)",
  },
  step: {
    backgroundColor: "var(--conan-color-content)",
    borderRadius: "var(--conan-radius-full)",
    color: "var(--conan-text-muted)",
    flexShrink: 0,
    minWidth: "var(--conan-icon-size)",
    textAlign: "center",
  },
  columnTitle: { flexGrow: 1, minWidth: 0 },
  count: {
    backgroundColor: "var(--conan-color-content)",
    borderRadius: "var(--conan-radius-full)",
    color: "var(--conan-text-muted)",
    flexShrink: 0,
    minWidth: "var(--conan-icon-size)",
    textAlign: "center",
  },
  empty: {
    color: "var(--conan-text-muted)",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-1)",
  },
  // The gap between two columns: one solid forward edge, one dashed return
  // edge. Sagan can send work back from ANY gate — the reference ledger's
  // WHA-130 is on round 3 because a human answered the promote gate `revise` —
  // so both kinds are drawn on every gap rather than implied.
  connector: {
    alignItems: "center",
    alignSelf: "center",
    flexShrink: 0,
    justifyContent: "center",
    paddingInline: "var(--conan-space-1)",
    width: "4.75rem",
  },
  edge: { alignItems: "center", color: "var(--conan-text-muted)" },
  edgeRule: {
    borderTopColor: "var(--conan-color-border-strong)",
    borderTopWidth: "var(--conan-border-width)",
    width: "100%",
  },
  edgeRuleSolid: { borderTopStyle: "solid" },
  edgeRuleDashed: { borderTopStyle: "dashed" },
  node: {
    alignItems: "stretch",
    appearance: "none",
    backgroundColor: {
      default: "var(--conan-color-content)",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-pressed)",
    },
    color: "inherit",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "var(--conan-space-2)",
    opacity: { default: 1, ":disabled": 0.5 },
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    outlineOffset: "2px",
    padding: "var(--conan-space-3)",
    textAlign: "start",
    width: "100%",
  },
  // Per-state SHAPE. Border style + weight + corner radius, all readable
  // without colour.
  nodeQueued: {
    border: "var(--conan-border-width) dashed var(--conan-color-border-strong)",
    borderRadius: "var(--conan-radius-md)",
  },
  nodeRunning: {
    border: "2px solid var(--conan-color-status-running)",
    borderRadius: "var(--conan-radius-md)",
  },
  nodeComplete: {
    border: "var(--conan-border-width) solid var(--conan-color-border)",
    borderRadius: "var(--conan-radius-md)",
  },
  nodeApproval: {
    border: "var(--conan-border-width) solid var(--conan-color-border-strong)",
    borderInlineStart: "4px solid var(--conan-color-warning)",
    borderRadius: "var(--conan-radius-md)",
  },
  nodeBlocked: {
    border: "2px dashed var(--conan-color-warning)",
    borderRadius: "var(--conan-radius-md)",
  },
  nodeFailed: {
    border: "2px solid var(--conan-color-error)",
    // Square corners — the one card shape that is not a rounded rectangle.
    borderRadius: "var(--conan-radius-xs)",
  },
  nodeSkipped: {
    border: "var(--conan-border-width) dotted var(--conan-color-border-strong)",
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-text-muted)",
  },
  nodeHead: { alignItems: "flex-start", width: "100%" },
  nodeTicket: { minWidth: 0, overflowWrap: "anywhere" },
  nodeGlyph: {
    color: "var(--conan-color-warning)",
    flexShrink: 0,
    lineHeight: 0,
  },
  // Two-line clamp; reserving the block height keeps sibling cards from jumping
  // when a title wraps (WHA-232 AC5).
  nodeTitle: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    minHeight: "2.5em",
    overflowWrap: "anywhere",
  },
  statusBlock: {
    alignItems: "stretch",
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-sm)",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-2)",
    width: "100%",
  },
  statusLabel: {
    color: "var(--conan-text-muted)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  statusRow: { alignItems: "flex-start" },
  // The pulse itself lives in `tokens.css`, keyed off `data-sagan-node-state`,
  // alongside the sidebar's status pulse and its `prefers-reduced-motion`
  // override (AC6). One place turns motion off for the whole shell.
  nodeActivity: { alignItems: "center", display: "inline-flex", flexShrink: 0 },
  nodeFooter: { alignItems: "center", flexWrap: "wrap" },
  // Non-interactive role chip — a Token inside the card <button> would nest
  // interactive elements. Visual weight matches Astryx Token `sm`.
  roleChip: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-sm)",
    color: "var(--conan-text-muted)",
    paddingBlock: "var(--conan-space-hair)",
    paddingInline: "var(--conan-space-2)",
  },
});

const NODE_SHAPES = {
  queued: styles.nodeQueued,
  running: styles.nodeRunning,
  complete: styles.nodeComplete,
  approval: styles.nodeApproval,
  blocked: styles.nodeBlocked,
  failed: styles.nodeFailed,
  skipped: styles.nodeSkipped,
} satisfies Record<SaganNodeState, unknown>;

function PipelineNode({
  run,
  stage,
  onSelect,
}: {
  run: SaganRunSummary;
  stage: StageSpec;
  onSelect: (run: SaganRunSummary, trigger: HTMLButtonElement) => void;
}) {
  const state = nodeStateFor(run);
  const spec = NODE_STATES[state];
  const StateIcon = spec.icon;
  const needsAttention = state === "approval" || state === "blocked";
  const status = statusBlockFor(run, state);
  const role = roleLabel(run);
  const statusBody = status?.note ?? status?.kind ?? null;

  return (
    <button
      type="button"
      onClick={(event) => onSelect(run, event.currentTarget)}
      data-sagan-ticket={run.ticket}
      data-sagan-node-state={state}
      aria-label={`${run.ticket}${run.title ? `, ${run.title}` : ""}, ${stage.label}, ${spec.label}`}
      {...stylex.props(styles.node, NODE_SHAPES[state])}
    >
      <HStack align="start" justify="between" gap={2} xstyle={styles.nodeHead}>
        <HStack align="center" gap={1} xstyle={styles.nodeTicket}>
          {state === "running" ? (
            <span data-slot="sagan-node-activity" {...stylex.props(styles.nodeActivity)}>
              <StateIcon size={14} aria-hidden />
            </span>
          ) : null}
          <Text weight="semibold" xstyle={styles.nodeTicket}>{run.ticket}</Text>
        </HStack>
        {needsAttention ? (
          <span
            data-slot="sagan-node-attention"
            title={spec.label}
            {...stylex.props(styles.nodeGlyph)}
          >
            <Info size={16} aria-hidden />
          </span>
        ) : null}
      </HStack>
      {run.title ? (
        <Text color="secondary" xstyle={styles.nodeTitle}>{run.title}</Text>
      ) : null}
      {status && statusBody ? (
        <VStack gap={1} xstyle={styles.statusBlock} data-slot="sagan-node-status">
          <Text type="supporting" xstyle={styles.statusLabel}>Status</Text>
          <HStack align="start" gap={2} xstyle={styles.statusRow}>
            <span data-slot="sagan-node-status-icon" {...stylex.props(styles.nodeActivity)}>
              <StateIcon size={14} aria-hidden />
            </span>
            <VStack gap={0.5} xstyle={styles.nodeTicket}>
              <Text type="supporting">{status.kind}</Text>
              {status.note && status.note !== status.kind ? (
                <Text color="secondary" type="supporting" xstyle={styles.nodeTicket}>
                  {status.note}
                </Text>
              ) : null}
            </VStack>
          </HStack>
        </VStack>
      ) : null}
      {role ? (
        <HStack align="center" gap={2} xstyle={styles.nodeFooter} data-slot="sagan-node-footer">
          <Text type="supporting" xstyle={styles.roleChip}>{role}</Text>
        </HStack>
      ) : null}
    </button>
  );
}

/** One gap between two stage columns. `role="img"` because the two edge kinds
 *  are one fact, and reading "Advance / Rework" three times is noise. */
function StageConnector({ from, to }: { from: StageSpec; to: StageSpec }) {
  return (
    <VStack
      gap={2}
      xstyle={styles.connector}
      role="img"
      aria-label={`${from.label} advances to ${to.label}; ${to.label} can send work back to ${from.label} for rework`}
      data-slot="sagan-stage-connector"
    >
      <VStack gap={0.5} xstyle={styles.edge} aria-hidden>
        <HStack align="center" gap={1}>
          <ArrowRight size={14} aria-hidden />
          <Text type="supporting" color="inherit">Advance</Text>
        </HStack>
        <div {...stylex.props(styles.edgeRule, styles.edgeRuleSolid)} />
      </VStack>
      <VStack gap={0.5} xstyle={styles.edge} aria-hidden>
        <div {...stylex.props(styles.edgeRule, styles.edgeRuleDashed)} />
        <HStack align="center" gap={1}>
          <Undo2 size={14} aria-hidden />
          <Text type="supporting" color="inherit">Rework</Text>
        </HStack>
      </VStack>
    </VStack>
  );
}

export default function SaganPipeline({
  runs,
  onSelect,
}: {
  runs: SaganRunSummary[];
  onSelect: (run: SaganRunSummary, trigger: HTMLButtonElement) => void;
}) {
  const grouped = new Map<SaganStage, SaganRunSummary[]>(
    SAGAN_STAGES.map((stage) => [stage.id, [] as SaganRunSummary[]]),
  );
  for (const run of runs) grouped.get(stageFor(run))!.push(run);

  return (
    <VStack gap={3} xstyle={styles.root} data-slot="sagan-pipeline">
      <HStack gap={4} align="center" xstyle={styles.legend}>
        <HStack align="center" gap={1} xstyle={styles.legendKey}>
          <ArrowRight size={14} aria-hidden />
          <div aria-hidden {...stylex.props(styles.legendLine, styles.legendLineSolid)} />
          <Text type="supporting" color="inherit">Advance — solid</Text>
        </HStack>
        <HStack align="center" gap={1} xstyle={styles.legendKey}>
          <Undo2 size={14} aria-hidden />
          <div aria-hidden {...stylex.props(styles.legendLine, styles.legendLineDashed)} />
          <Text type="supporting" color="inherit">Rework — dashed</Text>
        </HStack>
      </HStack>
      <HStack gap={0} align="stretch" xstyle={styles.board}>
        {SAGAN_STAGES.map((stage, index) => {
          const rows = grouped.get(stage.id)!;
          const StageIcon = stage.icon;
          const next = SAGAN_STAGES[index + 1];
          return [
            <VStack
              key={stage.id}
              gap={2}
              xstyle={styles.column}
              role="group"
              aria-label={`Stage ${stage.step} of ${SAGAN_STAGES.length}: ${stage.label}, ${rows.length} ${rows.length === 1 ? "task" : "tasks"}`}
              data-sagan-stage={stage.id}
            >
              <HStack align="center" gap={2} xstyle={styles.columnHeader}>
                <Text type="supporting" hasTabularNumbers xstyle={styles.step}>{stage.step}</Text>
                <StageIcon size={16} aria-hidden />
                <Text weight="semibold" xstyle={styles.columnTitle}>{stage.label}</Text>
                <Text type="supporting" hasTabularNumbers xstyle={styles.count}>{rows.length}</Text>
              </HStack>
              {rows.length > 0 ? (
                rows.map((run) => (
                  <PipelineNode key={run.id} run={run} stage={stage} onSelect={onSelect} />
                ))
              ) : (
                <Text type="supporting" xstyle={styles.empty}>No tasks</Text>
              )}
            </VStack>,
            next ? <StageConnector key={`${stage.id}-edge`} from={stage} to={next} /> : null,
          ];
        })}
      </HStack>
    </VStack>
  );
}
