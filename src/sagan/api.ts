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
// PROJECT SCOPING (AC3). A `projectId` names exactly ONE folder, and these
// routes read inside that folder only. Two ids are accepted, resolved in order:
//
//   1. a `project` table row id — the id `GET /api/agent/projects` hands the
//      UI, whose folder Conan already knows; and
//   2. an ABSOLUTE PATH on disk, which must exist, be a directory, and sit
//      inside a git repo (`findRepoRoot`) before it is accepted at all.
//
// Either way the ledger is composed from the REPO ROOT `findRepoRoot` walked
// to, never from the string that came off the wire, and the composed path is
// re-checked against that root through `realpath` before a byte is read — a
// symlinked `.sagan/` is the one way a contained-by-construction path still
// lands outside the project, and it is refused rather than followed.
//
// The `:id` in the detail route is only ever compared to ticket strings already
// read out of the file. It never reaches the filesystem, so there is no
// traversal to defend against there.
import fs from "node:fs";
import path from "node:path";
import { findRepoRoot, getChatProject } from "../agent/threads.js";
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
  /** The folder the id named — a project row's folder, or the path itself. */
  path: string;
  /** Repo root the ledger is read from — the only folder these routes touch. */
  root: string;
  /** Which resolution accepted the id. Reported rather than inferred, because
   *  the two have different trust stories and a surface debugging a wrong
   *  ledger needs to know which one answered. */
  source: "project-row" | "path";
  sagan: SaganCapability;
}

export interface SaganRunsResult {
  /** Null when the id resolved to no project at all — the list is empty and
   *  says why, rather than 404-ing a list route (AC4). */
  project: SaganProjectRef | null;
  ledgerPath: string | null;
  /** Most recently touched first (last ledger line wins). */
  runs: SaganRunSummary[];
  /** Lines the projection could not use, by reason — surfaced so a
   *  half-written or newer-than-Conan ledger is visible instead of silently
   *  short. */
  skipped: LedgerProjection["skipped"];
  /** The composed ledger path resolves OUTSIDE the repo root (a symlinked
   *  `.sagan/`). Nothing was read; surfaced so the empty list is explicable. */
  ledgerOutsideRoot: boolean;
  /** Why the list is empty when there is no project. Null when one resolved. */
  reason: string | null;
}

export interface SaganRunResult {
  project: SaganProjectRef;
  ledgerPath: string;
  run: SaganRunDetail;
}

const refFor = (
  id: string,
  name: string,
  dir: string,
  source: SaganProjectRef["source"],
): SaganProjectRef => {
  const sagan = detectSagan(dir);
  return {
    id,
    name,
    path: dir,
    // `detectSagan` already walked to the repo root; a project folder outside
    // any repo answers with itself, which is where its `.sagan/` would be.
    root: sagan.root ?? dir,
    source,
    sagan,
  };
};

/**
 * Accept a `projectId` that is a PATH on disk.
 *
 * Four things must hold before the path is a project, and each rejection is a
 * miss rather than an error the caller has to interpret:
 *
 *   - ABSOLUTE. A relative path would resolve against the gateway's own cwd,
 *     which is a different project's folder for anyone running Conan from a
 *     checkout. Nothing off the wire gets to mean "wherever I happen to be".
 *   - EXISTS, and is a DIRECTORY. A file is not a project root.
 *   - Inside a git repo. `findRepoRoot` walking to null means there is no root
 *     to scope the read to, and scoping is the whole point.
 *
 * `path.resolve` normalises `..` segments lexically before any of that, so a
 * traversal-shaped id is judged as the folder it actually names.
 */
function resolveProjectPath(projectId: string): SaganProjectRef | null {
  if (!path.isAbsolute(projectId)) return null;
  const dir = path.resolve(projectId);
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!findRepoRoot(dir)) return null;
  return refFor(dir, path.basename(dir) || dir, dir, "path");
}

/**
 * Resolve a client-supplied `projectId` to the one folder it may read.
 *
 * A project row id wins when one matches; otherwise the id is judged as a path
 * (see `resolveProjectPath`). Null when neither answers — the caller lists
 * nothing rather than falling back to the active cwd, because a stale id from a
 * closed project must not silently read whatever project happens to be open
 * (AC3).
 */
export function resolveSaganProject(projectId: string): SaganProjectRef | null {
  const id = projectId.trim();
  if (!id) return null;
  const row = getChatProject(id);
  if (row) return refFor(row.id, row.name, row.path, "project-row");
  return resolveProjectPath(id);
}

/** Absolute ledger path for a repo root. */
export function saganLedgerPath(root: string): string {
  return path.join(root, LEDGER_RELATIVE);
}

/**
 * Does this root's ledger really live inside this root?
 *
 * Composing `root + .sagan/ledger/events.jsonl` makes containment true of the
 * STRING, not of the file: a symlinked `.sagan/` (or a symlinked ledger) points
 * the read anywhere on disk while the path still looks scoped. Both sides are
 * resolved through `realpath` and compared, so the read is refused instead of
 * followed.
 *
 * A ledger that does not exist yet is contained by definition — nothing is
 * read, and a Sagan project that has never run is a normal state.
 */
export function ledgerWithinRoot(root: string): boolean {
  let realRoot: string;
  let realLedger: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  try {
    realLedger = fs.realpathSync(saganLedgerPath(root));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  const rel = path.relative(realRoot, realLedger);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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
 *  alongside the projection, so both shapes read the same file the same way.
 *  The containment check is HERE rather than at the routes, so every reader of
 *  this module gets it and no future caller can forget it. */
function replay(root: string): {
  ledgerPath: string;
  ledgerOutsideRoot: boolean;
  indexed: Array<{ index: number; event: RawEvent }>;
  projection: LedgerProjection;
} {
  const ledgerPath = saganLedgerPath(root);
  const contained = ledgerWithinRoot(root);
  const { events, unparseable } = contained
    ? readLedgerEvents(ledgerPath)
    : { events: [] as RawEvent[], unparseable: 0 };
  return {
    ledgerPath,
    ledgerOutsideRoot: !contained,
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
 * A project with no `.sagan/`, an unreadable marker, a ledger that does not
 * exist yet, and an id that resolved to no project AT ALL all answer the same
 * way: an empty `runs` list plus the field that says which of those it is —
 * `sagan` for the first three, `reason` for the last (AC4 — never a 500, and
 * never a bare empty list the surface cannot explain).
 */
export function listSaganRuns(project: SaganProjectRef | null): SaganRunsResult {
  if (!project) {
    return {
      project: null,
      ledgerPath: null,
      runs: [],
      skipped: { unparseable: 0, unknownType: 0, noTicket: 0 },
      ledgerOutsideRoot: false,
      reason: "no project resolved for that projectId",
    };
  }
  const { ledgerPath, ledgerOutsideRoot, indexed, projection } = replay(project.root);
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
  return {
    project,
    ledgerPath,
    runs,
    skipped: projection.skipped,
    ledgerOutsideRoot,
    reason: null,
  };
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
