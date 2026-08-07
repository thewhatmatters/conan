# T-000 — Example ticket (copy me)

- **status:** open
- **builder_id:** (set at dispatch)
- **verifier_id:** (set at verify)
- **evidence_sha:** (set by verify)

## AC

Write acceptance criteria BEFORE any dispatch. Rules learned the hard way:

1. Every clause must be judgeable from some role's declared input set — a
   clause referencing an external document must either ship that document
   in the critic's pack or be routed to verify as a quoted attestation.
2. Pin exact strings where wording matters; explicitly permit paraphrase
   or local variation where it doesn't. Ambiguities multiple workers flag
   independently are AC bugs.
3. Prefer criteria testable by command or observation (verify must be able
   to mark each item PASS/FAIL with evidence).

## Frontend

(builder appends here)

## QA

(verify appends here)

## Decisions

- (PM logs gate decisions here with dates)
