import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V2SaganSurface } from "../components/V2SurfaceBodies.tsx";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";
import type { SaganRunDetail, SaganRunSummary, SaganRunsResult } from "../../../../src/sagan/api.ts";

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
  updatedAt: Date.parse("2026-08-08T15:04:05Z"),
  ...patch,
});

const renderSurface = (value: SaganCapabilityResult) =>
  render(<V2SaganSurface token="tok" cwd="/repo/sagan" result={value} />);

const detail = (owningTarget: SaganRunDetail["context"]["owningTarget"] = null): SaganRunDetail => ({
  ...run({}),
  context: {
    objective: "Ship the ledger inspector",
    provider: "claude",
    containment: "prompt-gated",
    attemptId: "attempt-3",
    owningTarget,
  },
  lanes: [{ index: 0, lane: "frontend", phase: "built", round: 3, agent: { name: "Booker", role: "builder" }, artifact: "dist/report.html", sha: "abc123", flags: [], ts: "2026-08-05T10:00:00Z" }],
  verdicts: [],
  evidence: [{ index: 1, sha: "abc123", verifier: "Barkley", producer: null, overall: "PASS", checks: 5, notVerified: [], artifacts: ["evidence/inspector.png"], deltaOf: null, note: null, ts: "2026-08-07T11:00:00Z" }],
  resolvedDecisions: [],
  decisionHistory: [],
  history: [
    { index: 0, event: "lane.updated", ts: "2026-08-05T10:00:00Z", data: { event: "lane.updated", ticket: "WHA-130", lane: "frontend", output: "Built inspector" } },
    { index: 1, event: "evidence.recorded", ts: "2026-08-07T11:00:00Z", data: { event: "evidence.recorded", ticket: "WHA-130", overall: "PASS" } },
  ],
});

const mockDetail = (value: SaganRunDetail) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ run: value }),
  }));
};

afterEach(() => vi.unstubAllGlobals());

describe("V2SaganSurface overview", () => {
  it("renders loading", () => {
    renderSurface(result({ status: "loading", data: null }));
    expect(screen.getByText("Loading Sagan overview…")).toBeVisible();
  });

  it("renders an empty overview with every section", () => {
    renderSurface(result());
    expect(screen.getByText("No Sagan runs yet.")).toBeVisible();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    for (const label of ["Needs you", "Running now", "Up next", "Blocked", "Recently completed"]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("keeps stale data visible with a non-blocking refresh error", () => {
    renderSurface(result({ error: "Sagan runs could not be refreshed. Retrying…" }));
    expect(screen.getByText("No Sagan runs yet.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Retrying");
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

  it("opens a read-only in-surface inspector and returns focus on Escape", async () => {
    mockDetail(detail());
    renderSurface(result({ data: data([run({})]) }));
    const row = screen.getByRole("button", { name: /WHA-130, Awaiting decision/ });
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    expect(await screen.findByLabelText("Run inspector")).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveFocus();
    expect(screen.getByText("Ship the ledger inspector")).toBeVisible();
    expect(screen.getByText("prompt-gated")).toBeVisible();
    expect(screen.getByText("attempt-3")).toBeVisible();
    expect(screen.getByText("evidence/inspector.png")).toBeVisible();
    expect(screen.getByText("Read only · 2 events")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open owning thread/session" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: /WHA-130, Awaiting decision/ })).toHaveFocus());
    expect(screen.getByText("Overview")).toBeVisible();
  });

  it("shows the owning-session action only for a real ledger target", async () => {
    const onOpen = vi.fn();
    mockDetail(detail({ kind: "session", id: "session-42" }));
    render(
      <V2SaganSurface
        token="tok"
        cwd="/repo/sagan"
        result={result({ data: data([run({})]) })}
        onOpenOwningThread={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /WHA-130, Awaiting decision/ }));
    const action = await screen.findByRole("button", { name: "Open owning thread/session" });
    fireEvent.click(action);
    expect(onOpen).toHaveBeenCalledWith("session-42");
  });
});
