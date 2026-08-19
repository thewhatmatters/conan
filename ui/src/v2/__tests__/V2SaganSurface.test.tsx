import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V2SaganSurface } from "../components/V2SurfaceBodies.tsx";
import { nodeStateFor, stageFor } from "../components/SaganPipeline.tsx";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";
import type { SaganRunDetail, SaganRunSummary, SaganRunsResult } from "../../../../src/sagan/api.ts";

afterEach(() => cleanup());

const TERMINAL_LANES = ["done", "merged"];
const TERMINAL_PHASES = ["done", "merged", "complete", "completed"];
const isTerminalPosition = (lane: string | null, phase: string | null): boolean =>
  TERMINAL_LANES.includes(lane?.toLowerCase() ?? "") || TERMINAL_PHASES.includes(phase?.toLowerCase() ?? "");

const run = (patch: Partial<SaganRunSummary>): SaganRunSummary => {
  const lane = patch.lane ?? "critique";
  const phase = patch.phase ?? "dispatched";
  const terminal = isTerminalPosition(lane, phase);
  return {
    id: "WHA-130",
    ticket: "WHA-130",
    lane,
    phase,
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
    firstIsoTs: "2026-08-05T10:00:00Z",
    lastIsoTs: "2026-08-07T10:00:00Z",
    eventCount: 12,
    title: null,
    statusNote: null,
    completion: terminal
      ? { state: "done", source: "ledger", conflict: null }
      : { state: "open", source: null, conflict: null },
    ...patch,
  };
};

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
  timestampMismatch: 0,
  ledgerOutsideRoot: false,
  reason: null,
});

const result = (patch: Partial<SaganCapabilityResult> = {}): SaganCapabilityResult => ({
  available: true,
  autoPin: true,
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
  lanes: [{ index: 0, lane: "frontend", phase: "built", round: 3, agent: { name: "Booker", role: "builder" }, artifact: "dist/report.html", sha: "abc123", flags: [], note: null, ts: "2026-08-05T10:00:00Z", isoTs: "2026-08-05T10:00:00Z", tsKind: "exact" }],
  verdicts: [],
  evidence: [{ index: 1, sha: "abc123", verifier: "Barkley", producer: null, overall: "PASS", checks: 5, notVerified: [], artifacts: ["evidence/inspector.png"], deltaOf: null, note: null, ts: "2026-08-07T11:00:00Z", isoTs: "2026-08-07T11:00:00Z", tsKind: "exact" }],
  resolvedDecisions: [],
  decisionHistory: [],
  history: [
    { index: 0, event: "lane.updated", ts: "2026-08-05T10:00:00Z", isoTs: "2026-08-05T10:00:00Z", tsKind: "exact", data: { event: "lane.updated", ticket: "WHA-130", lane: "frontend", output: "Built inspector" } },
    { index: 1, event: "evidence.recorded", ts: "2026-08-07T11:00:00Z", isoTs: "2026-08-07T11:00:00Z", tsKind: "exact", data: { event: "evidence.recorded", ticket: "WHA-130", overall: "PASS" } },
  ],
});

const detailWithOpenDecisions = (owningTarget: SaganRunDetail["context"]["owningTarget"] = null): SaganRunDetail => ({
  ...detail(owningTarget),
  openDecisions: run({}).openDecisions,
  decisionHistory: [
    {
      gate: "promote",
      kind: "needed",
      decision: null,
      findings: [],
      amendment: null,
      state: "awaiting-randy",
      evidenceSha: "9be4459",
      round: 3,
      by: null,
      ts: "2026-08-07T11:00:00Z",
      isoTs: "2026-08-07T11:00:00Z",
      tsKind: "exact",
    },
  ],
});

const mockFetch = (value: SaganRunDetail) => {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ run: value }),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

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
    expect(screen.getByRole("button", { name: /WHA-130, Awaiting decision/ })).toHaveTextContent("critic-claude-freshcriticAwaiting decision2d");
  });

  it("places the optional run title after the ticket id and keeps the id-only fallback", () => {
    const titled = run({ id: "WHA-227", ticket: "WHA-227", title: "Run row hierarchy" });
    renderSurface(result({ data: data([titled, run({ id: "T-001", ticket: "T-001" })]) }));

    expect(screen.getByRole("button", { name: /WHA-227, Run row hierarchy, Awaiting decision/ }))
      .toHaveTextContent("WHA-227Run row hierarchy");
    expect(screen.getByRole("button", { name: /^T-001, Awaiting decision/ })).toBeVisible();
  });

  it("expands recorded run context without inventing missing fields", () => {
    renderSurface(result({ data: data([run({})]) }));
    const row = screen.getByRole("button", { name: /WHA-130, Awaiting decision/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("region", { name: "WHA-130 run context" })).not.toBeInTheDocument();

    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(row).toHaveAttribute("aria-controls", "sagan-run-WHA-130-details");
    expect(screen.getByRole("region", { name: "WHA-130 run context" })).toBeVisible();
    expect(screen.getByText("critic-claude-fresh (critic). dispatched in critique. Latest verdict: APPROVED.")).toBeVisible();
    expect(screen.getByText("Round 3")).toBeVisible();
    expect(screen.getByText("12 events")).toBeVisible();
    expect(screen.getByText("2 evidence records")).toBeVisible();
    expect(screen.getByRole("button", { name: "View run details" })).toBeVisible();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "View run details" })).not.toBeInTheDocument();
  });

  it("omits missing assignment and execution clauses and refuses day-only duration guesses", () => {
    renderSurface(result({ data: data([run({
      agent: null,
      lane: null,
      phase: null,
      round: null,
      verdict: null,
      eventCount: 0,
      evidenceCount: 0,
      firstIsoTs: null,
      lastIsoTs: null,
    })]) }));

    const row = screen.getByRole("button", { name: /WHA-130, Awaiting decision/ });
    expect(row).toHaveTextContent("—");
    fireEvent.click(row);
    const context = screen.getByRole("region", { name: "WHA-130 run context" });
    expect(within(context).queryByText(/No agent|No lane|No phase/)).not.toBeInTheDocument();
    expect(within(context).queryByText(/^Round /)).not.toBeInTheDocument();
    expect(within(context).getByText("0 events")).toBeVisible();
    expect(within(context).getByText("0 evidence records")).toBeVisible();
  });

  it("opens a read-only in-surface inspector from an expanded row and returns focus on Escape", async () => {
    mockDetail(detail());
    renderSurface(result({ data: data([run({})]) }));
    const row = screen.getByRole("button", { name: /WHA-130, Awaiting decision/ });
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "View run details" }));
    expect(await screen.findByLabelText("Run inspector")).toBeVisible();
    expect(await screen.findByText("Ship the ledger inspector")).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveFocus();
    expect(screen.getByText("prompt-gated")).toBeVisible();
    expect(screen.getByText("attempt-3")).toBeVisible();
    expect(screen.getByText("evidence/inspector.png")).toBeVisible();
    expect(screen.getByText("Read only · 2 events")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open owning thread/session" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: /WHA-130, Awaiting decision/ })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
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
    fireEvent.click(screen.getByRole("button", { name: "View run details" }));
    const action = await screen.findByRole("button", { name: "Open owning thread/session" });
    fireEvent.click(action);
    expect(onOpen).toHaveBeenCalledWith("session-42");
  });
});

/**
 * WHA-144 (C4) — the fixed 4-stage pipeline tab.
 *
 * The stage/state mapping is asserted as a table against the lane, phase and
 * verdict vocabulary of the reference ledger at `thewhatmatters/sagan` @
 * `ab2cb8d` (AC8): lanes `frontend | critique | verify | design | done`, phases
 * `dispatched | built | revise-dispatched | revised | delta-dispatched |
 * merged | building | pending-human-gate`, gates `promote |
 * art-direction-approval | human-review`.
 */
const bare = (patch: Partial<SaganRunSummary>): SaganRunSummary =>
  run({ openDecisions: [], needsYou: false, verdict: null, ...patch });

const openPipeline = () => fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));

/** jsdom lays nothing out, so the surface's own width has to be stated. A
 *  DOMRect instance cannot be spread — its fields are prototype getters, so the
 *  spread yields `{}` and the measurement reads as unmeasured. */
const measureSurface = (width: number) => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, width, height: 800 };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    ...rect,
    toJSON: () => rect,
  });
};

const stageColumn = (step: number, label: string) =>
  screen.getByRole("group", { name: new RegExp(`^Stage ${step} of 4: ${label},`) });

describe("Sagan pipeline stage mapping", () => {
  it.each([
    ["frontend", "built", "build"],
    ["design", "dispatched", "build"],
    // An unknown lane is work in progress, never a dropped node.
    ["docs-writer", "dispatched", "build"],
    [null, null, "build"],
    ["critique", "revise-dispatched", "critique"],
    ["verify", "delta-dispatched", "verify"],
    ["done", "merged", "promote"],
  ])("puts lane %s / phase %s in the %s stage", (lane, phase, expected) => {
    expect(stageFor(bare({ lane, phase }))).toBe(expected);
  });

  it("pins a run to the promote gate while its promote decision is open", () => {
    expect(stageFor(run({}))).toBe("promote");
  });

  it("leaves a non-promote gate on its own lane's stage", () => {
    const design = bare({
      lane: "design",
      phase: "dispatched",
      openDecisions: [{ gate: "art-direction-approval", state: "awaiting-randy", evidenceSha: null, round: 1 }],
    });
    expect(stageFor(design)).toBe("build");
    expect(nodeStateFor(design)).toBe("approval");
  });

  it.each([
    [bare({ lane: "queued", phase: null }), "queued"],
    [bare({ lane: "frontend", phase: "building" }), "running"],
    [bare({ lane: "done", phase: "merged" }), "complete"],
    [run({}), "approval"],
    [bare({ lane: "critique", phase: "dispatched", verdict: "REVISE" }), "blocked"],
    [bare({ lane: "critique", phase: "dispatched", verdict: "NEEDS_EVIDENCE" }), "blocked"],
    [bare({ lane: "critique", phase: "dispatched", verdict: "ESCALATE" }), "failed"],
    [bare({ lane: "verify", phase: "skipped" }), "skipped"],
  ])("derives the node state", (summary, expected) => {
    expect(nodeStateFor(summary)).toBe(expected);
  });
});

describe("V2SaganSurface pipeline tab", () => {
  const board = () =>
    data([
      bare({ id: "T-BUILD", ticket: "T-BUILD", lane: "frontend", phase: "building", round: 1 }),
      bare({
        id: "T-CRIT",
        ticket: "T-CRIT",
        lane: "critique",
        phase: "revise-dispatched",
        verdict: "REVISE",
        agent: { name: "critic-claude-fresh", role: "critic" },
      }),
      bare({
        id: "T-VERIFY",
        ticket: "T-VERIFY",
        lane: "verify",
        phase: "dispatched",
        agent: { name: "verify-claude", role: "verifier" },
      }),
      bare({ id: "T-DONE", ticket: "T-DONE", lane: "done", phase: "merged", agent: null }),
      run({}),
    ]);

  it("lays the four fixed stages out in order with labelled edges", () => {
    renderSurface(result({ data: board() }));
    openPipeline();
    for (const [step, label] of [[1, "Build"], [2, "Critique"], [3, "Verify"], [4, "Promote Gate"]] as const) {
      expect(stageColumn(step, label)).toBeVisible();
    }
    // Three gaps between four columns, each carrying BOTH edge kinds — a
    // dashed rework return exists from every gate in the Sagan loop.
    const connectors = screen.getAllByRole("img", { name: /advances to/ });
    expect(connectors).toHaveLength(3);
    expect(connectors[0]).toHaveAccessibleName(
      "Build advances to Critique; Critique can send work back to Build for rework",
    );
    expect(screen.getByText("Advance — solid")).toBeVisible();
    expect(screen.getByText("Rework — dashed")).toBeVisible();
  });

  it("files each run into its stage with role token footer chrome", () => {
    renderSurface(result({ data: board() }));
    openPipeline();
    expect(within(stageColumn(1, "Build")).getByRole("button", { name: /^T-BUILD,/ })).toBeVisible();
    expect(within(stageColumn(2, "Critique")).getByRole("button", { name: /^T-CRIT,/ })).toBeVisible();
    expect(within(stageColumn(3, "Verify")).getByRole("button", { name: /^T-VERIFY,/ })).toBeVisible();
    const promote = stageColumn(4, "Promote Gate");
    expect(within(promote).getByRole("button", { name: /^T-DONE,/ })).toBeVisible();
    expect(within(promote).getByRole("button", { name: /^WHA-130,/ })).toBeVisible();
    // Role token from the recorded agent.role — no invented duration.
    expect(screen.getByRole("button", { name: "T-CRIT, Critique, Blocked" })).toHaveTextContent("Critic");
    expect(screen.getByRole("button", { name: "T-VERIFY, Verify, Running" })).toHaveTextContent("Verifier");
    // No agent → no footer token (traces to a recorded field only).
    expect(within(screen.getByRole("button", { name: /^T-DONE,/ })).queryByText(/Unassigned|no role/i)).toBeNull();
  });

  it("gives every state its own shape hook, attention glyph, and Status kind", () => {
    renderSurface(result({ data: board() }));
    openPipeline();
    const states: Array<[string, string, boolean]> = [
      ["T-BUILD, Build, Running", "running", false],
      ["T-CRIT, Critique, Blocked", "blocked", true],
      ["T-VERIFY, Verify, Running", "running", false],
      ["T-DONE, Promote Gate, Complete", "complete", false],
      ["WHA-130, Promote Gate, Awaiting decision", "approval", true],
    ];
    for (const [name, state, attention] of states) {
      const node = screen.getByRole("button", { name });
      expect(node).toHaveAttribute("data-sagan-node-state", state);
      if (attention) {
        // Attention glyph is shared; Status row carries which kind.
        expect(node.querySelector('[data-slot="sagan-node-attention"]')).not.toBeNull();
        expect(node).toHaveTextContent(name.split(", ").at(-1)!);
        expect(node.querySelector('[data-slot="sagan-node-status"]')).not.toBeNull();
      } else {
        expect(node.querySelector('[data-slot="sagan-node-attention"]')).toBeNull();
      }
    }
    // Only the running node carries the activity element the pulse is keyed to;
    // `tokens.css` turns that one animation off under prefers-reduced-motion.
    expect(
      document.querySelectorAll('[data-sagan-node-state="running"] [data-slot="sagan-node-activity"]'),
    ).toHaveLength(2);
  });

  it("renders all seven node states distinctly without inventing a Collapsible", () => {
    // AC2 — greyscale-legible shape hooks for every state; AC4 — selection, not disclosure.
    renderSurface(result({
      data: data([
        bare({ id: "T-Q", ticket: "T-Q", lane: "queued", phase: null }),
        bare({ id: "T-R", ticket: "T-R", lane: "frontend", phase: "building" }),
        bare({ id: "T-C", ticket: "T-C", lane: "done", phase: "merged" }),
        run({ id: "T-A", ticket: "T-A" }),
        bare({ id: "T-B", ticket: "T-B", lane: "critique", phase: "dispatched", verdict: "REVISE" }),
        bare({ id: "T-F", ticket: "T-F", lane: "critique", phase: "dispatched", verdict: "ESCALATE" }),
        bare({ id: "T-S", ticket: "T-S", lane: "verify", phase: "skipped" }),
      ]),
    }));
    openPipeline();
    const expected: Array<[string, string]> = [
      ["T-Q, Build, Queued", "queued"],
      ["T-R, Build, Running", "running"],
      ["T-C, Promote Gate, Complete", "complete"],
      ["T-A, Promote Gate, Awaiting decision", "approval"],
      ["T-B, Critique, Blocked", "blocked"],
      ["T-F, Critique, Failed", "failed"],
      ["T-S, Verify, Skipped", "skipped"],
    ];
    const seen = new Set<string>();
    for (const [name, state] of expected) {
      const node = screen.getByRole("button", { name });
      expect(node).toHaveAttribute("data-sagan-node-state", state);
      expect(node.getAttribute("aria-expanded")).toBeNull();
      seen.add(state);
    }
    expect(seen.size).toBe(7);
  });

  it("shows a per-column empty state when a stage has no tasks", () => {
    renderSurface(result({
      data: data([bare({ id: "T-ONLY", ticket: "T-ONLY", lane: "frontend", phase: "building" })]),
    }));
    openPipeline();
    expect(within(stageColumn(1, "Build")).getByRole("button", { name: /^T-ONLY,/ })).toBeVisible();
    for (const [step, label] of [[2, "Critique"], [3, "Verify"], [4, "Promote Gate"]] as const) {
      expect(within(stageColumn(step, label)).getByText("No tasks")).toBeVisible();
    }
  });

  it("omits Status when there is no note on a non-attention card, and shows a recorded note when present", () => {
    renderSurface(result({
      data: data([
        bare({ id: "T-PLAIN", ticket: "T-PLAIN", lane: "frontend", phase: "building", statusNote: null }),
        bare({
          id: "T-NOTE",
          ticket: "T-NOTE",
          lane: "frontend",
          phase: "building",
          statusNote: "waiting on design tokens",
        }),
      ]),
    }));
    openPipeline();
    expect(
      screen.getByRole("button", { name: "T-PLAIN, Build, Running" })
        .querySelector('[data-slot="sagan-node-status"]'),
    ).toBeNull();
    const noted = screen.getByRole("button", { name: "T-NOTE, Build, Running" });
    expect(noted.querySelector('[data-slot="sagan-node-status"]')).not.toBeNull();
    expect(noted).toHaveTextContent("waiting on design tokens");
  });

  it("does not invent a title placeholder when the ticket file is missing", () => {
    renderSurface(result({ data: data([run({ title: null })]) }));
    openPipeline();
    const node = screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" });
    expect(node.textContent).not.toMatch(/placeholder|description|untitled/i);
  });

  it("opens the same inspector Overview does when a node is selected", async () => {
    mockDetail(detail());
    renderSurface(result({ data: board() }));
    openPipeline();
    const node = screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" });
    node.focus();
    fireEvent.click(node);
    expect(await screen.findByLabelText("Run inspector")).toBeVisible();
    expect(await screen.findByText("Ship the ledger inspector")).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" })).toHaveFocus(),
    );
  });

  it("renders a ticket title on a pipeline node when present", () => {
    renderSurface(result({ data: data([run({ title: "Auth session refresh" })]) }));
    openPipeline();
    const node = screen.getByRole("button", { name: /WHA-130, Auth session refresh, Promote Gate, Awaiting decision/ });
    expect(node).toHaveTextContent("Auth session refresh");
  });

  it("falls back to the Overview list at narrow widths instead of a mini-map", () => {
    measureSurface(420);
    renderSurface(result({ data: board() }));
    openPipeline();
    expect(screen.queryByRole("group", { name: /^Stage 1 of 4/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Too narrow for the pipeline board");
    for (const label of ["Needs you", "Running now", "Up next", "Blocked", "Recently completed"]) {
      // "Blocked" is both a section title and a row's state label here.
      expect(screen.getAllByText(label)[0]).toBeVisible();
    }
    expect(screen.getByRole("button", { name: /WHA-130, Awaiting decision/ })).toBeVisible();
  });

  it("keeps the board at a measured comfortable width", () => {
    measureSurface(900);
    renderSurface(result({ data: board() }));
    openPipeline();
    expect(stageColumn(1, "Build")).toBeVisible();
    expect(screen.queryByText(/Too narrow for the pipeline board/)).not.toBeInTheDocument();
  });
});

describe("Sagan inspector decision gates (WHA-145)", () => {
  const renderWithDecision = () => renderSurface(result({ data: data([run({})]) }));

  it("renders action buttons for an open decision gate", async () => {
    mockDetail(detailWithOpenDecisions());
    renderWithDecision();
    openPipeline();
    fireEvent.click(screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" }));
    await screen.findByLabelText("Run inspector");
    expect(screen.getByText("Decision gates")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Promote" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Revise" })).toBeVisible();
  });

  it("POSTs approve and refreshes the run detail", async () => {
    const value = detailWithOpenDecisions();
    const fetchMock = mockFetch(value);
    renderWithDecision();
    openPipeline();
    fireEvent.click(screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" }));
    await screen.findByLabelText("Run inspector");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const post = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/sagan/runs/WHA-130/decisions"));
    expect(post).toBeTruthy();
    const [url, options] = post!;
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ "x-conan-token": "tok" });
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ gate: "promote", decision: "approve" });
    expect(String(url)).toContain("projectId=%2Frepo%2Fsagan");
  });

  it("expands revise inputs and submits findings and amendment", async () => {
    const value = detailWithOpenDecisions();
    const fetchMock = mockFetch(value);
    renderWithDecision();
    openPipeline();
    fireEvent.click(screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" }));
    await screen.findByLabelText("Run inspector");
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(await screen.findByLabelText("Revise findings")).toBeVisible();
    expect(await screen.findByLabelText("Revise amendment")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Revise findings"), { target: { value: "missing tests\nneeds UI polish" } });
    fireEvent.change(screen.getByLabelText("Revise amendment"), { target: { value: "Add UI tests before re-critique" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit revise" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const post = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/sagan/runs/WHA-130/decisions"));
    const body = JSON.parse(post![1].body as string);
    expect(body).toEqual({
      gate: "promote",
      decision: "revise",
      findings: ["missing tests", "needs UI polish"],
      amendment: "Add UI tests before re-critique",
    });
  });

  it("cancels revise mode without posting", async () => {
    mockDetail(detailWithOpenDecisions());
    renderWithDecision();
    openPipeline();
    fireEvent.click(screen.getByRole("button", { name: "WHA-130, Promote Gate, Awaiting decision" }));
    await screen.findByLabelText("Run inspector");
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    await screen.findByLabelText("Revise findings");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Revise findings")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Revise" })).toBeVisible();
  });
});

/**
 * WHA-169 — the rendered half of the section fix. The rule itself is a table in
 * `saganSection.test.ts`; what is asserted here is that the board actually
 * draws these three runs in the sections that rule names, and that moving two
 * verdicts out of Blocked did not take the verdict off the row with them.
 *
 * All three shapes are real: WHA-140 as it stands in the ledger at `5cd617a`,
 * WHA-125 as it stood mid-verify on Aug 10, and an ESCALATE row for the one
 * verdict that still stops.
 */
describe("Sagan overview sections (WHA-169)", () => {
  // The section title's own row is the first match; a run's state label can
  // carry the same word further down the list.
  const section = (title: string) => screen.getAllByText(title)[0]!.closest("div")!.parentElement!;

  const board = () =>
    data([
      bare({ id: "WHA-140", ticket: "WHA-140", lane: "done", phase: "merged", round: 1, verdict: "REVISE", agent: null }),
      bare({
        id: "WHA-125",
        ticket: "WHA-125",
        lane: "verify",
        phase: "verifying",
        round: 1,
        verdict: "NEEDS_EVIDENCE",
        agent: { name: "hamilton", role: "verifier" },
      }),
      bare({ id: "T-ESC", ticket: "T-ESC", lane: "critique", phase: "critique", verdict: "ESCALATE" }),
    ]);

  it("files a merged run under Recently completed despite a stale REVISE", () => {
    renderSurface(result({ data: board() }));
    expect(section("Recently completed")).toHaveTextContent("WHA-140");
    expect(section("Blocked")).not.toHaveTextContent("WHA-140");
    expect(screen.getByRole("button", { name: "WHA-140, Completed" })).toBeVisible();
  });

  it("files a run being verified under Running now and keeps its verdict on the row", () => {
    renderSurface(result({ data: board() }));
    expect(section("Running now")).toHaveTextContent("WHA-125");
    expect(section("Blocked")).not.toHaveTextContent("WHA-125");
    const row = screen.getByRole("button", { name: "WHA-125, Running · NEEDS_EVIDENCE" });
    expect(row).toHaveTextContent("verify · verifying · NEEDS_EVIDENCE");
  });

  it("leaves ESCALATE — and only ESCALATE — under Blocked", () => {
    renderSurface(result({ data: board() }));
    const blocked = section("Blocked");
    expect(blocked).toHaveTextContent("T-ESC");
    expect(blocked).not.toHaveTextContent("WHA-1");
  });

  // Scoped to in-flight on purpose: a Blocked row's state label already says
  // ESCALATE in other words, and printing a merged run's last verdict is the
  // stale-signal noise WHA-167 exists to reconcile, not something to surface
  // here.
  it("prints the verdict only on an in-flight row", () => {
    renderSurface(result({ data: board() }));
    expect(screen.getByRole("button", { name: "T-ESC, Blocked" })).not.toHaveTextContent("ESCALATE");
    expect(screen.getByRole("button", { name: "WHA-140, Completed" })).not.toHaveTextContent("REVISE");
  });

  it("files an unknown completion under Recently completed with a disputed marker (WHA-167 AC3)", () => {
    renderSurface(result({ data: data([
      bare({
        id: "WHA-143",
        ticket: "WHA-143",
        lane: "frontend",
        phase: "building",
        completion: { state: "unknown", source: "git", conflict: { git: true, ticketFile: "ready-for-qa" } },
      }),
    ]) }));
    expect(section("Recently completed")).toHaveTextContent("WHA-143");
    expect(section("Running now")).not.toHaveTextContent("WHA-143");
    const row = screen.getByRole("button", { name: /WHA-143, Disputed/ });
    expect(row).toBeVisible();
    fireEvent.click(row);
    expect(screen.getByText(/git says merged/)).toBeVisible();
    expect(screen.getByText(/ticket file status is ready-for-qa/)).toBeVisible();
  });
});
