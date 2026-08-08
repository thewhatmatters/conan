// WHA-140 (B2): the read API over the WHA-137 projection.
//
// Two shapes, one replay. `GET /api/sagan/runs?projectId=…` lists a project's
// runs; `GET /api/sagan/runs/:id?projectId=…` returns one run in full. Both go
// through `readLedgerEvents` + `projectLedger` — the projection stays the ONLY
// place the decision resolver lives, and this module derives nothing it could
// have asked the projection for.
//
// What it DOES derive is the per-event-type detail the projection deliberately
// collapses. `TicketProjection` keeps the LAST lane and the LAST verdict,
// because the Needs-you queue only asks "where is this now". AC2 asks for
// "lanes, phases, verdicts … and history" — plural — and the inspector (C3)
// and pipeline (C4) render the whole sequence, so the lists below walk the same
// events a second time and keep every entry in file order. `ts` is day-granular
// and sometimes absent (see ledger.ts), so FILE ORDER is the ordering here too;
// every entry carries its ledger line `index` for that reason.
//
// PROJECT SCOPING (AC3) is structural, not a check: a `projectId` is resolved
// against the `project` table to a folder Conan already knows, `detectSagan`
// walks that folder to its repo root, and the ledger path is composed from THAT
// root. No path comes off the wire, and the `:id` in the detail route is only
// ever compared to ticket strings already read out of the file — it never
// reaches the filesystem, so there is no traversal to defend against.
import path from "node:path";
import { getChatProject } from "../agent/threads.js";
import { detectSagan, type SaganCapability } from "./detect.js";
import {
  projectLedger,
  readLedgerEvents,
  type DecisionEvent,
  type LedgerProjection,
  type OpenDecision,
  type RawEvent,
  type ResolvedDecision,
  type TicketProjection,
} from "./ledger.js";

/** Ledger path relative to the repo root, per the Sagan standard. */
export const LEDGER_RELATIVE = path.join(".sagan", "ledger", "events.jsonl");

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
/** `flags`/`not_verified`/`artifacts` are arrays of strings — except when they
 *  are a single string (`artifacts` is both in the reference ledger). */
const strings = (v: unknown): string[] => {
  if (typeof v === "string") return v ? [v] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
};

/** Who a lane was dispatched to. The ledger names the agent under a key that
 *  IS its role (`builder`/`critic`/`verifier`), so the role is not guessed. */
export interface SaganAgentRef {
  name: string;
  role: "builder" | "critic" | "verifier";
}

const agentOf = (e: RawEvent): SaganAgentRef | null => {
  const builder = str(e.builder);
  if (builder) return { name: builder, role: "builder" };
  const critic = str(e.critic);
  if (critic) return { name: critic, role: "critic" };
  const verifier = str(e.verifier);
  if (verifier) return { name: verifier, role: "verifier" };
  return null;
};

/** One `lane.updated`. Lanes and phases are open strings, never an enum. */
export interface SaganLaneEntry {
  /** Ledger line number (0-based), the only stable ordering. */
  index: number;
  lane: string | null;
  phase: string | null;
  round: number | null;
  agent: SaganAgentRef | null;
  /** The thing produced, when the event named one (`src/index.html`, `site/`). */
  artifact: string | null;
  /** `sha` or `artifact_sha` — the same fact under two names in the real file. */
  sha: string | null;
  flags: string[];
  ts: string | null;
}

/** One `critique.verdict`. `findings` is a COUNT here (it is a string array on
 *  `decision.made` — same key, different type, read per event type). */
export interface SaganVerdictEntry {
  index: number;
  round: number | null;
  critic: string | null;
  verdict: string | null;
  findings: number | null;
  blocking: number | null;
  high: number | null;
  artifactSha: string | null;
  /** `NEEDS_EVIDENCE` verdicts say what would settle them. */
  evidenceNeeded: string | null;
  ts: string | null;
}

/** One `evidence.recorded`. Two shapes appear in the reference ledger — a
 *  verifier run (`verifier` + `checks[]` + `overall`) and a produced artifact
 *  set (`producer` + `artifacts`) — and both are kept whole rather than
 *  flattened, because C3 renders "output/artifacts" from either. */
export interface SaganEvidenceEntry {
  index: number;
  sha: string | null;
  verifier: string | null;
  producer: string | null;
  /** `PASS` / `FAIL` as recorded by the verifier. */
  overall: string | null;
  /** Number of individual AC checks, when the event carried them. */
  checks: number;
  notVerified: string[];
  artifacts: string[];
  /** Set on a delta verification: the sha this one is a delta of. */
  deltaOf: string | null;
  note: string | null;
  ts: string | null;
}

/** One ledger line for this ticket, verbatim under `data`. The inspector's
 *  read-only timeline; nothing is dropped, so a Sagan build that adds an event
 *  type Conan has never heard of still renders as a row. */
export interface SaganHistoryEntry {
  index: number;
  event: string;
  ts: string | null;
  data: Record<string, unknown>;
}

/** A run in the list. Ticket id IS the run id in Sagan v0. */
export interface SaganRunSummary {
  /** The route key for `/api/sagan/runs/:id`. Same value as `ticket`. */
  id: string;
  ticket: string;
  /** Current position: the last lane touched and the phase it was left in. */
  lane: string | null;
  phase: string | null;
  round: number | null;
  /** Last critique verdict: APPROVED | REVISE | NEEDS_EVIDENCE | ESCALATE. */
  verdict: string | null;
  /** Whoever the last lane named — C2's "assigned agent/role" column. */
  agent: SaganAgentRef | null;
  /** Gates whose LAST event is `decision.needed`. */
  openDecisions: OpenDecision[];
  /** `openDecisions.length > 0` — the Needs-you predicate, named once here so
   *  every surface counts it the same way. */
  needsYou: boolean;
  laneCount: number;
  verdictCount: number;
  evidenceCount: number;
  /** First and last `ts` seen. Day-granular strings; may be null. */
  firstTs: string | null;
  lastTs: string | null;
  eventCount: number;
}

/** A run in full — the inspector's (C3) and pipeline's (C4) whole payload. */
export interface SaganRunDetail extends SaganRunSummary {
  lanes: SaganLaneEntry[];
  verdicts: SaganVerdictEntry[];
  evidence: SaganEvidenceEntry[];
  /** Gates already answered (last event per gate). */
  resolvedDecisions: ResolvedDecision[];
  /** Every decision event in file order, nothing collapsed — this is what says
   *  WHY a ticket is on round 3. */
  decisionHistory: DecisionEvent[];
  history: SaganHistoryEntry[];
}

/** The project a request is scoped to, resolved from its id. */
export interface SaganProjectRef {
  id: string;
  name: string;
  /** The folder the user added to Conan. */
  path: string;
  /** Repo root the ledger is read from — the only folder these routes touch. */
  root: string;
  sagan: SaganCapability;
}

export interface SaganRunsResult {
  project: SaganProjectRef;
  ledgerPath: string;
  /** Most recently touched first (last ledger line wins). */
  runs: SaganRunSummary[];
  /** Lines the projection could not use, by reason — surfaced so a
   *  half-written or newer-than-Conan ledger is visible instead of silently
   *  short. */
  skipped: LedgerProjection["skipped"];
}

export interface SaganRunResult {
  project: SaganProjectRef;
  ledgerPath: string;
  run: SaganRunDetail;
}

/**
 * Resolve a client-supplied `projectId` to the one folder it may read.
 *
 * Null when no project row carries that id — the caller answers 404 rather than
 * falling back to the active cwd, because a stale id from a closed project must
 * not silently read whatever project happens to be open (AC3).
 */
export function resolveSaganProject(projectId: string): SaganProjectRef | null {
  const row = getChatProject(projectId);
  if (!row) return null;
  const sagan = detectSagan(row.path);
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    // `detectSagan` already walked to the repo root; a project folder outside
    // any repo answers with itself, which is where its `.sagan/` would be.
    root: sagan.root ?? row.path,
    sagan,
  };
}

/** Absolute ledger path for a repo root. */
export function saganLedgerPath(root: string): string {
  return path.join(root, LEDGER_RELATIVE);
}

const summarize = (t: TicketProjection, events: RawEvent[]): SaganRunSummary => {
  let laneCount = 0;
  let verdictCount = 0;
  let evidenceCount = 0;
  let agent: SaganAgentRef | null = null;
  for (const e of events) {
    if (e.event === "lane.updated") {
      laneCount += 1;
      agent = agentOf(e) ?? agent;
    } else if (e.event === "critique.verdict") verdictCount += 1;
    else if (e.event === "evidence.recorded") evidenceCount += 1;
  }
  return {
    id: t.ticket,
    ticket: t.ticket,
    lane: t.lane,
    phase: t.phase,
    round: t.round,
    verdict: t.verdict,
    agent,
    openDecisions: t.openDecisions,
    needsYou: t.openDecisions.length > 0,
    laneCount,
    verdictCount,
    evidenceCount,
    firstTs: t.firstTs,
    lastTs: t.lastTs,
    eventCount: t.eventCount,
  };
};

/** Replay a root's ledger once: raw events (with their line index) kept
 *  alongside the projection, so both shapes read the same file the same way. */
function replay(root: string): {
  ledgerPath: string;
  indexed: Array<{ index: number; event: RawEvent }>;
  projection: LedgerProjection;
} {
  const ledgerPath = saganLedgerPath(root);
  const { events, unparseable } = readLedgerEvents(ledgerPath);
  return {
    ledgerPath,
    indexed: events.map((event, index) => ({ index, event })),
    projection: projectLedger(events, unparseable),
  };
}

/** Ledger lines belonging to one ticket, in file order. */
const linesFor = (
  indexed: Array<{ index: number; event: RawEvent }>,
  ticket: string,
): Array<{ index: number; event: RawEvent }> =>
  indexed.filter(({ event }) => str(event.ticket) === ticket);

/**
 * Every run in a project, most recently touched first.
 *
 * A project with no `.sagan/`, an unreadable marker, or a ledger that does not
 * exist yet all answer the same way: an empty `runs` list plus the `sagan`
 * capability that says which of those it is (AC4 — never a 500, and never a
 * bare empty list the surface cannot explain).
 */
export function listSaganRuns(project: SaganProjectRef): SaganRunsResult {
  const { ledgerPath, indexed, projection } = replay(project.root);
  const lastLine = new Map<string, number>();
  for (const { index, event } of indexed) {
    const id = str(event.ticket);
    if (id) lastLine.set(id, index);
  }
  const runs = projection.tickets
    .map((t) => summarize(t, linesFor(indexed, t.ticket).map((l) => l.event)))
    // `ts` is day-granular and often absent, so recency is the last ledger LINE
    // the ticket appears on — the same ordering rule the projection folds on.
    .sort((a, b) => (lastLine.get(b.ticket) ?? -1) - (lastLine.get(a.ticket) ?? -1));
  return { project, ledgerPath, runs, skipped: projection.skipped };
}

/**
 * One run in full, or null when the ledger has no such ticket (the caller
 * answers 404). The id is matched against ticket strings read out of the file;
 * it is never joined onto a path.
 */
export function getSaganRun(
  project: SaganProjectRef,
  ticketId: string,
): SaganRunResult | null {
  const { ledgerPath, indexed, projection } = replay(project.root);
  const t = projection.tickets.find((x) => x.ticket === ticketId);
  if (!t) return null;

  const lines = linesFor(indexed, ticketId);
  const lanes: SaganLaneEntry[] = [];
  const verdicts: SaganVerdictEntry[] = [];
  const evidence: SaganEvidenceEntry[] = [];
  const history: SaganHistoryEntry[] = [];

  for (const { index, event: e } of lines) {
    history.push({
      index,
      event: e.event,
      ts: str(e.ts),
      data: e as Record<string, unknown>,
    });
    switch (e.event) {
      case "lane.updated":
        lanes.push({
          index,
          lane: str(e.lane),
          phase: str(e.phase),
          round: num(e.round),
          agent: agentOf(e),
          artifact: str(e.artifact),
          sha: str(e.sha) ?? str(e.artifact_sha),
          flags: strings(e.flags),
          ts: str(e.ts),
        });
        break;
      case "critique.verdict":
        verdicts.push({
          index,
          round: num(e.round),
          critic: str(e.critic),
          verdict: str(e.verdict),
          findings: num(e.findings),
          blocking: num(e.blocking),
          high: num(e.high),
          artifactSha: str(e.artifact_sha) ?? str(e.sha),
          evidenceNeeded: str(e.evidence_needed),
          ts: str(e.ts),
        });
        break;
      case "evidence.recorded":
        evidence.push({
          index,
          sha: str(e.sha) ?? str(e.evidence_sha),
          verifier: str(e.verifier),
          producer: str(e.producer),
          overall: str(e.overall),
          checks: Array.isArray(e.checks) ? e.checks.length : 0,
          notVerified: strings(e.not_verified),
          artifacts: strings(e.artifacts),
          deltaOf: str(e.delta_of),
          note: str(e.note) ?? str(e.for),
          ts: str(e.ts),
        });
        break;
      default:
        break;
    }
  }

  return {
    project,
    ledgerPath,
    run: {
      ...summarize(
        t,
        lines.map((l) => l.event),
      ),
      lanes,
      verdicts,
      evidence,
      resolvedDecisions: t.resolvedDecisions,
      decisionHistory: t.decisionHistory,
      history,
    },
  };
}
