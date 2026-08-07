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
//   1. `ts` is a DAY-granular string ("2026-08-06") and is missing entirely on
//      some events. It cannot order anything. FILE ORDER is the only ordering,
//      which is exactly what the decision resolver below depends on.
//
//   2. Field names and even field TYPES vary by event type. `findings` is a
//      count on `critique.verdict` and an array of strings on `decision.made`;
//      a git sha is `sha`, `artifact_sha` or `evidence_sha` depending on who
//      wrote it. Each event type is read on its own terms rather than through
//      one merged shape.
import fs from "node:fs";

/** Every event type observed in the reference ledger. Unknown types are skipped,
 *  not fatal — the standard is v0 and will grow types before Conan learns them. */
const KNOWN_EVENTS = new Set([
  "run.started",
  "lane.updated",
  "critique.verdict",
  "evidence.recorded",
  "decision.needed",
  "decision.made",
]);

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
  /** Gates already answered, in ledger order. */
  resolvedDecisions: ResolvedDecision[];
  evidence: EvidenceRef[];
  /** First and last `ts` seen. Day-granular strings; may be null. */
  firstTs: string | null;
  lastTs: string | null;
  eventCount: number;
}

export interface LedgerProjection {
  /** Ticket id IS the run id in Sagan v0 (`T-001`, `WHA-130`, …). */
  tickets: TicketProjection[];
  /** Lines that were not usable, by reason. Surfaced rather than swallowed so a
   *  half-written ledger is visible instead of silently short. */
  skipped: { unparseable: number; unknownType: number; noTicket: number };
}

interface RawEvent {
  event: string;
  ticket?: string;
  [key: string]: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

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
        evidence: [],
        firstTs: null,
        lastTs: null,
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

    const ts = str(e.ts);
    if (ts) {
      if (!t.firstTs) t.firstTs = ts;
      t.lastTs = ts;
    }
    // `round` rides on several event types; the highest seen is the run's round.
    const round = num(e.round);
    if (round !== null && (t.round === null || round > t.round)) t.round = round;

    switch (e.event) {
      case "lane.updated":
        // Lanes are open-ended strings — the reference ledger has a `design`
        // lane with no file under `.sagan/roles/`. Never an enum.
        t.lane = str(e.lane) ?? t.lane;
        t.phase = str(e.phase) ?? t.phase;
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

  return { tickets: [...byTicket.values()], skipped };
}

/** Replay a ledger file. Missing file → an empty projection, not a throw: a
 *  Sagan project that has never run is a normal state, not an error. */
export function readLedger(ledgerPath: string): LedgerProjection {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return { tickets: [], skipped: { unparseable: 0, unknownType: 0, noTicket: 0 } };
  }
  const { events, unparseable } = parseLedger(text);
  return projectLedger(events, unparseable);
}

/** Every ticket with at least one gate waiting on a human — the Needs-you set. */
export function needsYou(projection: LedgerProjection): TicketProjection[] {
  return projection.tickets.filter((t) => t.openDecisions.length > 0);
}
