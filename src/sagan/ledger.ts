// WHA-137 (A2): read `.sagan/ledger/events.jsonl` and fold it into what the
// Sagan surface needs to draw.
//
// THE LEDGER IS THE SOURCE OF TRUTH. `sagan.yaml` says so — `pm.state: ledger,
// appended continuously` — and the file is committed to the repo, so any Sagan
// tool can read it. Conan therefore DERIVES its view by replaying the file and
// never authors run state of its own. Nothing here writes, caches, or persists:
// a projection that can disagree with the ledger is worse than no projection,
// and 42 events over 19KB replay faster than a cache would pay for itself.
// Caching, if it is ever needed, is A3 — with a measurement attached.
//
// Two properties of the real file drive the whole design:
//
//   1. `ts` is a DAY-granular string ("2026-08-06") on older events; current
//      fleet events use `timestamp` and are full ISO-8601 instants. The reader
//      keeps the raw value, classifies it as `exact | day | none`, and exposes
//      the ISO instant only when it is real. FILE ORDER stays the only ordering
//      — the resolver does not depend on timestamps — but durations are now
//      honest instead of invented from a calendar date (WHA-225).
//
//   2. Field names and even field TYPES vary by event type. `findings` is a
//      count on `critique.verdict` and an array of strings on `decision.made`;
//      a git sha is `sha`, `artifact_sha` or `evidence_sha` depending on who
//      wrote it. Each event type is read on its own terms rather than through
//      one merged shape.
import fs from "node:fs";
import path from "node:path";

/** Every event type observed in the reference ledger. Unknown types are skipped,
 *  not fatal — the standard is v0 and will grow types before Conan learns them. */
const KNOWN_EVENTS = new Set([
  "run.started",
  "run.completed",
  "lane.updated",
  "critique.verdict",
  "evidence.recorded",
  "decision.needed",
  "decision.made",
]);

/** How precise an event's timestamp is. `exact` means a full ISO-8601 instant;
 *  `day` means a calendar-date string only; `none` means the event carried no
 *  timestamp at all. The UI reads this to decide whether it may print a
 *  duration (WHA-225). */
export type TimestampKind = "exact" | "day" | "none";

export interface OpenDecision {
  gate: string;
  /** e.g. `awaiting-randy`, `awaiting-promote`. */
  state: string | null;
  evidenceSha: string | null;
  round: number | null;
}

export interface ResolvedDecision {
  gate: string;
  /** Open set — `promote`, `approve`, `revise` all appear. */
  decision: string;
  by: string | null;
  /** Present on `revise`: what the human objected to. */
  findings: string[];
  /** Present on `revise`: an AC rewritten mid-run. */
  amendment: string | null;
}

export interface EvidenceRef {
  sha: string | null;
  verifier: string | null;
  /** `PASS` / `FAIL` as recorded by the verifier. */
  overall: string | null;
  /** Number of individual checks recorded, when the event carried them. */
  checks: number;
}

/** One decision event, kept verbatim in file order (WHA-137.1).
 *
 *  `openDecisions` answers "is this gate waiting on a human" and deliberately
 *  keeps only the last event per gate. That erases the answer that REOPENED a
 *  gate: WHA-130's round 3 exists precisely because a human replied `revise`
 *  with findings and an AC amendment, and last-event-wins throws that away.
 *  The inspector needs to say WHY a ticket is on round 3, so the full sequence
 *  is kept alongside — additive, and the resolver is untouched. */
export interface DecisionEvent {
  gate: string;
  kind: "needed" | "made";
  /** `made` only: `promote` | `approve` | `revise` | … (open set). */
  decision: string | null;
  /** `made` only, and only on some verbs: what the human objected to. */
  findings: string[];
  /** `made` only: an AC rewritten mid-run. */
  amendment: string | null;
  /** `needed` only: e.g. `awaiting-randy`. */
  state: string | null;
  evidenceSha: string | null;
  round: number | null;
  by: string | null;
  /** Raw timestamp as it appeared in the ledger (`ts` or `timestamp`). */
  ts: string | null;
  /** ISO-8601 timestamp only; null for day-granular or missing timestamps. */
  isoTs: string | null;
  /** Classification of this event's timestamp: exact instant, day-only, or absent. */
  tsKind: TimestampKind;
}

export interface TicketProjection {
  ticket: string;
  /** Last lane touched, and the phase it was left in. */
  lane: string | null;
  phase: string | null;
  /** Highest round seen on any event for this ticket. */
  round: number | null;
  /** Last critique verdict: APPROVED | REVISE | NEEDS_EVIDENCE | ESCALATE. */
  verdict: string | null;
  /** Gates whose LAST event is `decision.needed` — the Needs-you queue. */
  openDecisions: OpenDecision[];
  /** Gates already answered, in ledger order. Last event per gate only — a
   *  superseded answer is NOT here; it is in `decisionHistory`. */
  resolvedDecisions: ResolvedDecision[];
  /** Every decision event for this ticket, in file order, nothing collapsed.
   *  This is the record the inspector reads; `openDecisions` is the state the
   *  Needs-you queue reads. They answer different questions. */
  decisionHistory: DecisionEvent[];
  evidence: EvidenceRef[];
  /** First and last raw timestamp seen (`ts` or `timestamp`). Day-granular
   *  strings; may be null. Kept verbatim so the UI can fall back to the ledger
   *  value when an exact instant is not available. */
  firstTs: string | null;
  lastTs: string | null;
  /** Classification of `firstTs` / `lastTs`. */
  firstTsKind: TimestampKind;
  lastTsKind: TimestampKind;
  /** First and last ISO-8601 timestamp seen; null when no ISO timestamp exists. */
  firstIsoTs: string | null;
  lastIsoTs: string | null;
  /** True when the ledger itself says the run finished: a terminal lane/phase
   *  event or an explicit `run.completed` event. */
  completed: boolean;
  eventCount: number;
}

export interface LedgerProjection {
  /** Ticket id IS the run id in Sagan v0 (`T-001`, `WHA-130`, …). */
  tickets: TicketProjection[];
  /** Lines that were not usable, by reason. Surfaced rather than swallowed so a
   *  half-written ledger is visible instead of silently short. */
  skipped: { unparseable: number; unknownType: number; noTicket: number };
  /** Events where `ts` and `timestamp` were both ISO-8601 instants but differed.
   *  Kept separate from `skipped` because the event IS used — `timestamp` wins —
   *  but the caller may want to warn that two fields disagreed. */
  timestampMismatch: number;
}

/** One ledger line, verbatim. Field names and types vary by `event` (see the
 *  header), so every reader takes the keys it knows on that type's terms.
 *  Exported because WHA-140's read API replays the SAME events this module
 *  folds — it derives the per-event-type detail the projection deliberately
 *  collapses, and re-parsing the file a second way would be a second truth. */
export interface RawEvent {
  event: string;
  ticket?: string;
  [key: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

const TERMINAL_LANES = new Set(["done", "merged"]);
const TERMINAL_PHASES = new Set(["done", "merged", "complete", "completed"]);
const isTerminalPosition = (lane: string | null, phase: string | null): boolean =>
  TERMINAL_LANES.has(lane?.toLowerCase() ?? "") || TERMINAL_PHASES.has(phase?.toLowerCase() ?? "");

/** True when `value` is an ISO-8601 timestamp with a time component.
 *
 *  Day-granular strings like "2026-08-06" are deliberately NOT accepted — the
 *  whole point of the ISO-8601 contract is to avoid inventing a time of day.
 *  Offsets (`+00:00`) and the UTC suffix (`Z`) are both allowed. */
export function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
}

/** Parsed timestamp plus the classification the UI needs to decide what it can
 *  render (WHA-225). */
export interface TimestampClassification {
  /** The raw timestamp string we would show; prefers `ts` then `timestamp`. */
  ts: string | null;
  /** ISO-8601 instant when the event carried one; null otherwise. */
  isoTs: string | null;
  /** Why `isoTs` is null, or `exact` when it is not. */
  tsKind: TimestampKind;
  /** Both `ts` and `timestamp` were present, parsed as full instants, and differed. */
  disagreement: boolean;
}

/** Classify an event's timestamp fields.
 *
 *  Old ledgers use `ts`; current fleet events use `timestamp`. `timestamp` is
 *  treated as authoritative: when it is a full ISO-8601 instant it wins over
 *  any `ts` value, and the raw `ts` field returned here is the SAME raw value
 *  so `ts` and `tsKind` never disagree. If both fields are ISO instants and
 *  they differ, we still pick `timestamp` but flag the mismatch so the caller
 *  can surface it instead of silently asserting one value. */
export function classifyTimestamp(e: RawEvent): TimestampClassification {
  const ts = str(e.ts);
  const timestamp = str(e.timestamp);
  const tsIso = ts && isIsoTimestamp(ts) ? ts : null;
  const timestampIso = timestamp && isIsoTimestamp(timestamp) ? timestamp : null;

  let isoTs: string | null = null;
  let rawTs: string | null = null;
  let disagreement = false;

  if (timestampIso) {
    // `timestamp` is authoritative when it is a full instant.
    isoTs = timestampIso;
    rawTs = timestamp;
    if (tsIso && tsIso !== timestampIso) disagreement = true;
  } else if (tsIso) {
    isoTs = tsIso;
    rawTs = ts;
  } else if (timestamp) {
    rawTs = timestamp;
  } else if (ts) {
    rawTs = ts;
  }

  const tsKind: TimestampKind = isoTs ? "exact" : rawTs ? "day" : "none";
  return { ts: rawTs, isoTs, tsKind, disagreement };
}

/** Pick the best ISO-8601 timestamp available for an event. */
export function isoTimestampOf(e: RawEvent): string | null {
  return classifyTimestamp(e).isoTs;
}

/**
 * Parse ledger text into events, in file order.
 *
 * A line that does not parse is COUNTED and skipped, never thrown. The append
 * path (WHA-145) writes one line per `O_APPEND` call, but atomicity is not a
 * crash guarantee: a process killed mid-write leaves a partial final line, and
 * a reader that throws on it would blank the whole surface at exactly the
 * moment someone needs to see what happened.
 */
export function parseLedger(text: string): {
  events: RawEvent[];
  unparseable: number;
} {
  const events: RawEvent[] = [];
  let unparseable = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as RawEvent);
        continue;
      }
      unparseable += 1;
    } catch {
      unparseable += 1;
    }
  }
  return { events, unparseable };
}

/**
 * Fold events into one projection per ticket.
 *
 * The decision resolver is the part with teeth: a gate's state is the LAST
 * event for `(ticket, gate)` in file order, not "does a `decision.made` exist".
 * WHA-130 in the reference ledger goes `needed → made(revise) → needed(round 3)`,
 * so an existence check reports it answered and drops the one ticket actually
 * waiting on a human out of the Needs-you queue.
 */
export function projectLedger(events: RawEvent[], unparseable = 0): LedgerProjection {
  const skipped = { unparseable, unknownType: 0, noTicket: 0 };
  let timestampMismatch = 0;
  /** Per ticket, per gate: the last decision event seen, in file order. */
  const gates = new Map<string, Map<string, RawEvent>>();
  const byTicket = new Map<string, TicketProjection>();

  const ticketOf = (id: string): TicketProjection => {
    let t = byTicket.get(id);
    if (!t) {
      t = {
        ticket: id,
        lane: null,
        phase: null,
        round: null,
        verdict: null,
        openDecisions: [],
        resolvedDecisions: [],
        decisionHistory: [],
        evidence: [],
        firstTs: null,
        lastTs: null,
        firstTsKind: "none",
        lastTsKind: "none",
        firstIsoTs: null,
        lastIsoTs: null,
        completed: false,
        eventCount: 0,
      };
      byTicket.set(id, t);
    }
    return t;
  };

  for (const e of events) {
    if (!KNOWN_EVENTS.has(e.event)) {
      skipped.unknownType += 1;
      continue;
    }
    const id = str(e.ticket);
    if (!id) {
      skipped.noTicket += 1;
      continue;
    }
    const t = ticketOf(id);
    t.eventCount += 1;

    // Early Sagan ledgers used `ts`; current fleet events use the more explicit
    // `timestamp`. Classify the timestamp so the UI knows whether it can show a
    // duration, and prefer `timestamp` when both fields are present (WHA-225).
    const classified = classifyTimestamp(e);
    if (classified.ts) {
      if (!t.firstTs) t.firstTs = classified.ts;
      t.lastTs = classified.ts;
      t.lastTsKind = classified.tsKind;
      if (t.firstTsKind === "none") t.firstTsKind = classified.tsKind;
    }
    if (classified.isoTs) {
      if (!t.firstIsoTs) t.firstIsoTs = classified.isoTs;
      t.lastIsoTs = classified.isoTs;
    }
    if (classified.disagreement) timestampMismatch += 1;
    // `round` rides on several event types; the highest seen is the run's round.
    const round = num(e.round);
    if (round !== null && (t.round === null || round > t.round)) t.round = round;

    switch (e.event) {
      case "run.completed":
        // An explicit finish signal from the runner. The event may carry a
        // `result`; the position update below is enough for the projection.
        t.completed = true;
        t.lane = str(e.lane) ?? t.lane ?? "done";
        t.phase = str(e.phase) ?? t.phase ?? "merged";
        break;
      case "lane.updated":
        // Lanes are open-ended strings — the reference ledger has a `design`
        // lane with no file under `.sagan/roles/`. Never an enum.
        t.lane = str(e.lane) ?? t.lane;
        t.phase = str(e.phase) ?? t.phase;
        if (isTerminalPosition(t.lane, t.phase)) t.completed = true;
        break;
      case "critique.verdict":
        t.verdict = str(e.verdict) ?? t.verdict;
        break;
      case "evidence.recorded":
        t.evidence.push({
          sha: str(e.sha),
          verifier: str(e.verifier),
          overall: str(e.overall),
          checks: Array.isArray(e.checks) ? e.checks.length : 0,
        });
        break;
      case "decision.needed":
      case "decision.made": {
        const gate = str(e.gate);
        if (!gate) break;
        let perGate = gates.get(id);
        if (!perGate) {
          perGate = new Map();
          gates.set(id, perGate);
        }
        perGate.set(gate, e); // last write wins — this IS the resolver
        // …and the same event is appended verbatim, because the resolver's
        // answer and the ticket's history are different questions.
        t.decisionHistory.push({
          gate,
          kind: e.event === "decision.needed" ? "needed" : "made",
          decision: str(e.decision),
          findings: Array.isArray(e.findings)
            ? e.findings.filter((f): f is string => typeof f === "string")
            : [],
          amendment: str(e.amendment),
          state: str(e.state),
          evidenceSha: str(e.evidence_sha),
          round: num(e.round),
          by: str(e.by),
          ts: classified.ts,
          isoTs: classified.isoTs,
          tsKind: classified.tsKind,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const [id, perGate] of gates) {
    const t = ticketOf(id);
    for (const [gate, e] of perGate) {
      if (e.event === "decision.needed") {
        t.openDecisions.push({
          gate,
          state: str(e.state),
          evidenceSha: str(e.evidence_sha),
          round: num(e.round),
        });
      } else {
        t.resolvedDecisions.push({
          gate,
          decision: str(e.decision) ?? "unknown",
          by: str(e.by),
          // `findings` is an array here and a COUNT on critique.verdict. Same
          // key, different type — read per event type, never merged.
          findings: Array.isArray(e.findings)
            ? e.findings.filter((f): f is string => typeof f === "string")
            : [],
          amendment: str(e.amendment),
        });
      }
    }
  }

  return { tickets: [...byTicket.values()], skipped, timestampMismatch };
}

/** Read + parse a ledger file. Missing/unreadable file → zero events, not a
 *  throw: a Sagan project that has never run is a normal state, not an error. */
export function readLedgerEvents(ledgerPath: string): {
  events: RawEvent[];
  unparseable: number;
} {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return { events: [], unparseable: 0 };
  }
  return parseLedger(text);
}

/** Replay a ledger file into the projection. */
export function readLedger(ledgerPath: string): LedgerProjection {
  const { events, unparseable } = readLedgerEvents(ledgerPath);
  return projectLedger(events, unparseable);
}

/** Every ticket with at least one gate waiting on a human — the Needs-you set. */
export function needsYou(projection: LedgerProjection): TicketProjection[] {
  return projection.tickets.filter((t) => t.openDecisions.length > 0);
}

export interface DecisionAppendInput {
  ticket: string;
  gate: string;
  decision: "approve" | "promote" | "revise" | string;
  by: string;
  round: number | null;
  findings?: string[];
  amendment?: string;
}

export interface DecisionAppendResult {
  event: DecisionAppendInput & { event: "decision.made"; timestamp: string };
}

/**
 * Append a `decision.made` line to the ledger for a human gate decision.
 *
 * The gate MUST currently have an open `decision.needed` event — the last
 * decision event for `(ticket, gate)` in file order must be `needed`, not
 * `made`. This is the same rule the projection uses; a `made` on a closed
 * gate would silently reopen a decision that was already answered, or write a
 * duplicate answer to a closed gate.
 *
 * The round is copied from the matching open `decision.needed` event so the
 * ledger stays internally consistent. The caller may supply an explicit round
 * only when no open decision is found, which is always an error path.
 */
export function appendDecisionMade(
  ledgerPath: string,
  input: DecisionAppendInput,
): DecisionAppendResult {
  const { events } = readLedgerEvents(ledgerPath);
  const lastDecision = new Map<string, RawEvent>();
  const key = `${input.ticket}\0${input.gate}`;
  for (const e of events) {
    if (e.event !== "decision.needed" && e.event !== "decision.made") continue;
    const ticket = str(e.ticket);
    const gate = str(e.gate);
    if (!ticket || !gate) continue;
    lastDecision.set(`${ticket}\0${gate}`, e);
  }
  const open = lastDecision.get(key);
  if (!open || open.event !== "decision.needed") {
    throw new Error(`Gate ${input.gate} for ${input.ticket} has no open decision.needed event`);
  }

  const round = input.round ?? num(open.round) ?? null;
  const event = {
    event: "decision.made" as const,
    ticket: input.ticket,
    gate: input.gate,
    decision: input.decision,
    by: input.by,
    round,
    timestamp: new Date().toISOString(),
    ...(input.findings && input.findings.length > 0 ? { findings: input.findings } : {}),
    ...(input.amendment ? { amendment: input.amendment } : {}),
  };

  const line = JSON.stringify(event) + "\n";
  const dir = path.dirname(ledgerPath);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(ledgerPath, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  return { event };
}
