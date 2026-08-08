import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { V2SaganSurface } from "../components/V2SurfaceBodies.tsx";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";
import type { SaganRunSummary, SaganRunsResult } from "../../../../src/sagan/api.ts";

const run = (patch: Partial<SaganRunSummary>): SaganRunSummary => ({
  id: "WHA-130",
  ticket: "WHA-130",
  lane: "critique",
  phase: "dispatched",
  round: 3,
  verdict: "APPROVED",
  agent: { name: "critic-claude-fresh", role: "critic" },
  openDecisions: [{ gate: "promote", state: "awaiting-randy", evidenceSha: "9be4459", round: 3 }],
  needsYou: true,
  laneCount: 3,
  verdictCount: 3,
  evidenceCount: 2,
  firstTs: "2026-08-05",
  lastTs: "2026-08-07",
  eventCount: 12,
  ...patch,
});

const data = (runs: SaganRunSummary[] = []): SaganRunsResult => ({
  project: {
    id: "/repo/sagan",
    name: "sagan",
    path: "/repo/sagan",
    root: "/repo/sagan",
    source: "path",
    sagan: { state: "valid", root: "/repo/sagan", manifestPath: "/repo/sagan/.sagan/sagan.yaml", version: null },
  },
  ledgerPath: "/repo/sagan/.sagan/ledger/events.jsonl",
  runs,
  skipped: { unparseable: 0, unknownType: 0, noTicket: 0 },
  ledgerOutsideRoot: false,
  reason: null,
});

const result = (patch: Partial<SaganCapabilityResult> = {}): SaganCapabilityResult => ({
  available: true,
  projectPath: "/repo/sagan",
  status: "ready",
  data: data(),
  error: null,
  ...patch,
});

const renderSurface = (value: SaganCapabilityResult) =>
  render(<V2SaganSurface token="tok" cwd="/repo/sagan" result={value} />);

describe("V2SaganSurface overview", () => {
  it("renders loading", () => {
    renderSurface(result({ status: "loading", data: null }));
    expect(screen.getByText("Loading Sagan overview…")).toBeVisible();
  });

  it("renders an empty overview with every section", () => {
    renderSurface(result());
    expect(screen.getByText("No Sagan runs yet.")).toBeVisible();
    for (const label of ["Needs you", "Running now", "Up next", "Blocked", "Recently completed"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("renders a fetch error", () => {
    renderSurface(result({ status: "error", data: null, error: "Sagan runs could not be loaded." }));
    expect(screen.getByText("Sagan runs could not be loaded.")).toBeVisible();
  });

  it("renders malformed configuration details", () => {
    const malformed = data();
    malformed.project!.sagan = {
      state: "invalid",
      root: "/repo/sagan",
      manifestPath: "/repo/sagan/.sagan/sagan.yaml",
      version: null,
      reason: ".sagan/sagan.yaml has no recognisable Sagan keys",
    };
    renderSurface(result({ data: malformed }));
    expect(screen.getByText(/no recognisable Sagan keys/)).toBeVisible();
  });

  it("shows only the reopened unresolved decision in Needs you", () => {
    renderSurface(result({ data: data([
      run({}),
      run({ id: "T-001", ticket: "T-001", openDecisions: [], needsYou: false, lane: "done", phase: "completed" }),
    ]) }));
    const needsYou = screen.getByText("Needs you").closest("div")!.parentElement!;
    expect(needsYou).toHaveTextContent("WHA-130");
    expect(needsYou).not.toHaveTextContent("T-001");
    expect(screen.getByRole("button", { name: /WHA-130, Awaiting decision/ })).toHaveTextContent("critic-claude-freshcriticAwaiting decision2 days");
  });

  it("supports keyboard focus and activation for overview rows", () => {
    renderSurface(result({ data: data([run({})]) }));
    const row = screen.getByRole("button", { name: /WHA-130, Awaiting decision/ });
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row).toHaveFocus();
  });
});
