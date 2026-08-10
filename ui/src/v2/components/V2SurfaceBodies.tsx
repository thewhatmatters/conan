import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import {
  ArrowLeft,
  CircleCheck,
  CircleHelp,
  ExternalLink,
  Folder,
  LayoutList,
  ListTodo,
  OctagonAlert,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Workflow,
} from "lucide-react";
import TerminalEngine from "../../components/Terminal.tsx";
import { apiBase, isTauri } from "../../lib/gateway.ts";
import type { BrowserSurfaceReport } from "../../hooks/useAgentChat.ts";
import type { SaganRunDetail, SaganRunResult, SaganRunSummary } from "../../../../src/sagan/api.ts";
import type { SaganCapabilityResult } from "../lib/useSaganCapability.ts";
import { SAGAN_SECTIONS, sectionFor, type SaganSection } from "../lib/saganSection.ts";
import { useNativeBrowser } from "../lib/useNativeBrowser.ts";
import { parseUnifiedPatch } from "../../lib/diff.ts";
import V2DiffView from "./V2DiffView.tsx";
import SaganInspector from "./SaganInspector.tsx";
import SaganPipeline, { SAGAN_PIPELINE_MIN_WIDTH } from "./SaganPipeline.tsx";
import {
  buildFileTree,
  rollupFileStatus,
  V2FileTree,
  type FileStatus,
  type FileTreeNode,
} from "./V2FileTree.tsx";

const styles = stylex.create({
  // WHA-115 — the pane header is a glass overlay sitting ON this box, not a
  // row above it. The top inset is what keeps the first row clear of the bar
  // while still letting everything below scroll under it: padding-block-start
  // on a scroll container is part of the scrollable area, so the content slides
  // under the glass rather than stopping at it.
  //
  // Every `body` consumer therefore uses LONGHAND padding below — a `padding`
  // shorthand in a later style would silently reset this inset and hide the
  // surface's first row under the bar.
  body: {
    backgroundColor: "var(--conan-color-content)",
    boxSizing: "border-box",
    color: "var(--conan-text-primary)",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "auto",
    paddingBlockStart: "var(--conan-secondary-bar-height)",
    width: "100%",
  },
  // Block-start restates the header inset so the surface keeps the same gap
  // below the bar it had when the bar was a row above it.
  padded: {
    paddingBlockEnd: "var(--conan-space-4)",
    paddingBlockStart: "calc(var(--conan-secondary-bar-height) + var(--conan-space-4))",
    paddingInline: "var(--conan-space-4)",
  },
  /**
   * WHA-120 — for a surface that owns a scroller, the pane is an OVERLAY
   * stack, not a column of rows.
   *
   * WHA-115 gave `body` a top inset so its content cleared the pane's glass
   * bar. That works while `body` is itself the scroller. It stops working the
   * moment a surface nests its own (WHA-114 gave Files and Diff a path row
   * plus `treeScroller`): the inner scroller then starts BELOW both bars, so
   * nothing ever passes under the glass and the bar reads flat. Measured at
   * `1df121e`: bar bottom y=129, scroller top y=161.
   *
   * The fix is to stop stacking and start layering. `body` drops its inset and
   * becomes the positioning context; the surface's own toolbar joins the glass
   * band as a second frosted bar; and the scroller runs the FULL pane height
   * with a top inset covering both. Rows then slide under the path row and the
   * pane bar in one motion, which is what "you can vaguely see the content
   * behind it" asks for.
   */
  overlayBody: {
    overflow: "clip",
    paddingBlockStart: 0,
    position: "relative",
  },
  surfaceHeader: {
    alignItems: "center",
    borderBottom: "var(--conan-border-width) solid var(--conan-color-border)",
    boxSizing: "border-box",
    display: "flex",
    flexShrink: 0,
    gap: "var(--conan-space-2)",
    // Fixed, not `min-height`: `overlayScroller` below offsets by exactly this
    // value, and a header free to grow would silently hide the first row.
    height: "var(--conan-control-height)",
    paddingInline: "var(--conan-space-3)",
  },
  // The surface's own toolbar, lifted into the pane's glass band (WHA-120).
  // Same tint and blur as the pane header above it, so the two read as one
  // frosted stack divided by the rule `surfaceHeader` already draws.
  glassHeader: {
    backdropFilter: "blur(var(--conan-glass-blur))",
    WebkitBackdropFilter: "blur(var(--conan-glass-blur))",
    backgroundColor: "var(--conan-glass-tint)",
    insetInline: 0,
    position: "absolute",
    top: "var(--conan-secondary-bar-height)",
    zIndex: 2,
  },
  // The Browser's URL row as a glass bar (WHA-120). No fixed height and no
  // matching offset on the frame below it, unlike `surfaceHeader`: the frame
  // fills the whole pane and the page inside scrolls itself, so there is no
  // "first row" that has to clear the bar.
  browserBar: {
    alignItems: "center",
    borderBottom: "var(--conan-border-width) solid var(--conan-color-border)",
    boxSizing: "border-box",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-4)",
  },
  // Fills the pane behind the two glass bars rather than starting below them.
  frameFill: {
    inset: 0,
    position: "absolute",
  },
  headerPath: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-pressed)",
    },
    border: 0,
    borderRadius: "var(--conan-radius-xs)",
    color: "var(--conan-icon-muted)",
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    justifyContent: "center",
    padding: "var(--conan-space-1)",
  },
  // Longhand, not the `padding` shorthand it used to be: `overlayScroller`
  // overrides only the block-start, and a shorthand here would win and put the
  // first row back under the glass.
  treeScroller: {
    flexGrow: 1,
    minHeight: 0,
    overflow: "auto",
    paddingBlock: "var(--conan-space-1)",
    paddingInline: "var(--conan-space-1)",
  },
  // Clears BOTH frosted bars — the pane's and the surface's own — while
  // leaving the scroller itself spanning the full pane, which is what lets
  // rows scroll up under them instead of stopping at them.
  overlayScroller: {
    paddingBlockStart:
      "calc(var(--conan-secondary-bar-height) + var(--conan-control-height) + var(--conan-space-1))",
  },
  count: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-full)",
    color: "var(--conan-text-muted)",
    flexShrink: 0,
    paddingBlock: "var(--conan-space-hair)",
    paddingInline: "var(--conan-space-2)",
  },
  stat: {
    display: "inline-flex",
    gap: "var(--conan-space-1)",
    whiteSpace: "nowrap",
  },
  statAdd: { color: "var(--conan-diff-add-text)" },
  statDel: { color: "var(--conan-diff-del-text)" },
  statDivider: { color: "var(--conan-text-dim)" },
  inlineError: { color: "var(--conan-color-error)" },
  fill: { flexGrow: 1, minHeight: 0, minWidth: 0, width: "100%" },
  // WHA-120 — the terminal keeps its inset, deliberately, and this is the one
  // surface where "content under the glass" is the WRONG answer.
  //
  // xterm is TOP-anchored until its scrollback exceeds the viewport — measured
  // on a fresh shell, the prompt paints on the container's first row rather
  // than at its foot. Give the terminal the full pane and
  // that prompt renders under the frosted bar, blurred and unreadable, until
  // enough output pushes it up — the state a user is in every single time they
  // open the surface. Scrollback that has already left the viewport is clipped
  // by xterm's own scroller, not drawn under ours, so full-bleed buys nothing
  // for the scrolled case either. Cost with no benefit; the bar stays solid
  // over the terminal's own tone.
  terminal: {
    backgroundColor: "var(--conan-color-terminal)",
    paddingBlockEnd: "var(--conan-space-2)",
    paddingBlockStart: "calc(var(--conan-secondary-bar-height) + var(--conan-space-2))",
    paddingInline: "var(--conan-space-2)",
  },
  frame: {
    backgroundColor: "var(--conan-color-bg)",
    border: 0,
    height: "100%",
    width: "100%",
  },
  row: {
    borderRadius: "var(--conan-radius-md)",
    justifyContent: "flex-start",
    width: "100%",
  },
  staleNotice: {
    backgroundColor: "var(--conan-wash-hover)",
    borderRadius: "var(--conan-radius-md)",
    paddingBlock: "var(--conan-space-2)",
    paddingInline: "var(--conan-space-3)",
    width: "100%",
  },
  preview: {
    backgroundColor: "var(--conan-color-bg)",
    borderRadius: "var(--conan-radius-md)",
    fontFamily: "var(--conan-font-mono)",
    overflow: "auto",
    padding: "var(--conan-space-3)",
    whiteSpace: "pre-wrap",
  },
  saganOverview: {
    alignItems: "stretch",
    paddingBlockEnd: "var(--conan-space-6)",
    paddingBlockStart: "calc(var(--conan-secondary-bar-height) + var(--conan-space-4))",
    paddingInline: "var(--conan-space-5)",
  },
  saganHeader: {
    borderBottom: "var(--conan-border-width) solid var(--conan-color-border)",
    paddingBlockEnd: "var(--conan-space-4)",
    width: "100%",
  },
  saganHeaderStatus: { alignItems: "flex-end" },
  saganSection: { alignItems: "stretch", width: "100%" },
  saganSectionTitle: { color: "var(--conan-text-primary)" },
  saganCount: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-full)",
    minWidth: "var(--conan-icon-size)",
    paddingInline: "var(--conan-space-2)",
    textAlign: "center",
  },
  saganRow: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-pressed)",
    },
    border: 0,
    borderRadius: "var(--conan-radius-md)",
    color: "inherit",
    cursor: "pointer",
    display: "grid",
    gap: "var(--conan-space-3)",
    gridTemplateColumns: "minmax(8rem, 1.4fr) minmax(7rem, 1fr) minmax(7rem, 1fr) auto",
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    outlineOffset: "2px",
    padding: "var(--conan-space-3)",
    textAlign: "start",
    width: "100%",
  },
  saganCell: { minWidth: 0 },
  saganDuration: { justifySelf: "end", whiteSpace: "nowrap" },
  saganEmpty: {
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-text-muted)",
    padding: "var(--conan-space-3)",
  },
  saganTabs: { flexShrink: 0 },
  // WHA-144 — the narrow-width note above the Overview list the Pipeline tab
  // falls back to, so the swap is explained rather than looking like a bug.
  saganFallbackNote: { color: "var(--conan-text-muted)" },
});

function CenterState({ children }: { children: string }) {
  return (
    <VStack align="center" justify="center" gap={2} xstyle={[styles.body, styles.padded]}>
      <Text color="secondary">{children}</Text>
    </VStack>
  );
}

function durationOf(run: SaganRunSummary): string {
  if (!run.firstTs) return "Duration unknown";
  const start = Date.parse(run.firstTs);
  const end = run.lastTs ? Date.parse(run.lastTs) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Duration unknown";
  const days = Math.max(0, Math.round((end - start) / 86_400_000));
  return days === 0 ? "<1 day" : `${days} day${days === 1 ? "" : "s"}`;
}

const SECTION_STATE = {
  "Needs you": { icon: CircleHelp, label: "Awaiting decision" },
  "Running now": { icon: PlayCircle, label: "Running" },
  "Up next": { icon: ListTodo, label: "Queued" },
  Blocked: { icon: OctagonAlert, label: "Blocked" },
  "Recently completed": { icon: CircleCheck, label: "Completed" },
} satisfies Record<SaganSection, { icon: typeof CircleHelp; label: string }>;

function SaganRow({
  run,
  section,
  onSelect,
}: {
  run: SaganRunSummary;
  section: SaganSection;
  onSelect: (run: SaganRunSummary, trigger: HTMLButtonElement) => void;
}) {
  const state = SECTION_STATE[section];
  const StateIcon = state.icon;
  // WHA-169 AC3 — an in-flight row keeps showing its last verdict. `REVISE` and
  // `NEEDS_EVIDENCE` moved out of Blocked and into Running now; the point was
  // to stop calling live work stopped, not to hide that a critic sent it back.
  // It rides the existing lane · phase line — one more term, no new column and
  // no new control — and the ledger's own casing, the same string the inspector
  // prints, so nothing acquires a second display name.
  const verdictNote = section === "Running now" && run.verdict ? ` · ${run.verdict}` : "";
  return (
    <button
      type="button"
      onClick={(event) => onSelect(run, event.currentTarget)}
      data-sagan-ticket={run.ticket}
      {...stylex.props(styles.saganRow)}
      aria-label={`${run.ticket}, ${state.label}${verdictNote}`}
    >
      <VStack gap={0.5} xstyle={styles.saganCell}>
        <Text weight="semibold">{run.ticket}</Text>
        <Text color="secondary" type="supporting">
          {run.lane ?? "Unassigned lane"} · {run.phase ?? "No phase"}{verdictNote}
        </Text>
      </VStack>
      <VStack gap={0.5} xstyle={styles.saganCell}>
        <Text>{run.agent?.name ?? "Unassigned"}</Text>
        <Text color="secondary" type="supporting">{run.agent?.role ?? "No role"}</Text>
      </VStack>
      <HStack align="center" gap={2} xstyle={styles.saganCell}>
        <StateIcon size={16} aria-hidden />
        <Text>{state.label}</Text>
      </HStack>
      <Text color="secondary" type="supporting" xstyle={styles.saganDuration}>{durationOf(run)}</Text>
    </button>
  );
}

/** The Sagan surface's internal views. The SurfaceId stays `sagan` — these are
 *  tabs INSIDE the one surface, and both drive the same inspector (AC5). */
type SaganTab = "overview" | "pipeline";

export function V2SaganSurface({
  token,
  cwd,
  result,
  onOpenOwningThread,
}: {
  token: string | null;
  cwd: string | null;
  result?: SaganCapabilityResult;
  onOpenOwningThread?: (id: string) => void;
}) {
  const [tab, setTab] = useState<SaganTab>("overview");
  const [narrow, setNarrow] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const [detail, setDetail] = useState<SaganRunDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<"idle" | "loading" | "error">("idle");
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedTicket || !token || !cwd) return;
    const controller = new AbortController();
    setDetail(null);
    setDetailStatus("loading");
    void (async () => {
      try {
        const response = await fetch(
          apiBase() + `/api/sagan/runs/${encodeURIComponent(selectedTicket)}?projectId=${encodeURIComponent(cwd)}`,
          { headers: { "x-conan-token": token }, signal: controller.signal },
        );
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as SaganRunResult;
        if (!controller.signal.aborted) {
          setDetail(payload.run);
          setDetailStatus("idle");
        }
      } catch {
        if (!controller.signal.aborted) setDetailStatus("error");
      }
    })();
    return () => controller.abort();
  }, [cwd, selectedTicket, token, detailRefreshKey]);

  /**
   * WHA-144 (AC7) — the narrow-width fallback is a MEASUREMENT, not a guess.
   *
   * The Sagan surface is a resizable pane, so its width has nothing to do with
   * the viewport's and a media query would answer the wrong question. Below
   * `SAGAN_PIPELINE_MIN_WIDTH` the board is replaced by the Overview list (whose
   * rows open the same full-height inspector) rather than being squeezed into an
   * unreadable mini-map.
   *
   * A width of 0 — a pane that has not laid out yet, or jsdom, which lays
   * nothing out — is UNMEASURED, not narrow, so the board is the default and
   * only a real measurement takes it away.
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      if (width > 0) setNarrow(width < SAGAN_PIPELINE_MIN_WIDTH);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [selectedTicket, result?.status]);

  const selectRun = useCallback((selected: SaganRunSummary, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setDetailStatus("loading");
    setSelectedTicket(selected.id);
  }, []);

  const closeInspector = useCallback(() => {
    const ticket = selectedTicket;
    setSelectedTicket(null);
    setDetail(null);
    setDetailStatus("idle");
    requestAnimationFrame(() => {
      const nextTrigger = [...document.querySelectorAll<HTMLButtonElement>("[data-sagan-ticket]")]
        .find((candidate) => candidate.dataset.saganTicket === ticket);
      (nextTrigger ?? triggerRef.current)?.focus();
    });
  }, [selectedTicket]);

  if (selectedTicket) {
    return (
      <SaganInspector
        run={detail}
        loading={detailStatus === "loading"}
        error={detailStatus === "error" ? "Run details could not be loaded." : null}
        onClose={closeInspector}
        onOpenOwningTarget={onOpenOwningThread}
        token={token}
        cwd={cwd}
        onDecisionMade={() => setDetailRefreshKey((k) => k + 1)}
      />
    );
  }
  if (!result || result.status === "idle" || result.status === "loading") {
    return <CenterState>Loading Sagan overview…</CenterState>;
  }
  if (result.status === "error") return <CenterState>{result.error ?? "Sagan runs could not be loaded."}</CenterState>;
  const data = result.data;
  const capability = data?.project?.sagan;
  if (!data || !Array.isArray(data.runs)) return <CenterState>Sagan returned malformed run data.</CenterState>;
  if (capability?.state === "invalid" || capability?.state === "unsupported-version") {
    return <CenterState>{capability.reason ?? "The Sagan configuration is malformed."}</CenterState>;
  }
  if (capability?.state !== "valid") return <CenterState>Sagan is unavailable for this project.</CenterState>;

  const grouped = new Map<SaganSection, SaganRunSummary[]>(SAGAN_SECTIONS.map((section) => [section, []]));
  for (const run of data.runs) grouped.get(sectionFor(run))!.push(run);
  const needsYouCount = grouped.get("Needs you")!.length;
  const showPipeline = tab === "pipeline" && !narrow;

  return (
    <VStack
      ref={rootRef}
      gap={5}
      xstyle={[styles.body, styles.saganOverview]}
      data-sagan-pane={showPipeline ? "pipeline" : "overview"}
    >
      <HStack align="center" justify="between" gap={3} xstyle={styles.saganHeader}>
        <TabList
          value={tab}
          onChange={(value) => setTab(value as SaganTab)}
          aria-label="Sagan views"
          xstyle={styles.saganTabs}
        >
          <Tab value="overview" label="Overview" icon={<LayoutList size={16} aria-hidden />} />
          <Tab value="pipeline" label="Pipeline" icon={<Workflow size={16} aria-hidden />} />
        </TabList>
        <VStack gap={0.5} xstyle={styles.saganHeaderStatus}>
          <Text color="secondary">{needsYouCount} needs you</Text>
          {result.updatedAt ? (
            <Text color="secondary" type="supporting">
              Updated {new Date(result.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
            </Text>
          ) : null}
          {result.error ? <Text color="secondary" type="supporting" role="status">{result.error}</Text> : null}
        </VStack>
      </HStack>
      {showPipeline ? (
        <SaganPipeline runs={data.runs} onSelect={selectRun} />
      ) : (
        <>
          {tab === "pipeline" ? (
            <Text type="supporting" role="status" xstyle={styles.saganFallbackNote}>
              Too narrow for the pipeline board — showing the Overview list. Widen
              the surface to bring it back.
            </Text>
          ) : null}
          {data.runs.length === 0 ? <Text color="secondary">No Sagan runs yet.</Text> : null}
          {SAGAN_SECTIONS.map((section) => {
            const rows = grouped.get(section)!;
            return (
              <VStack key={section} gap={2} xstyle={styles.saganSection}>
                <HStack align="center" gap={2}>
                  <Text weight="semibold" xstyle={styles.saganSectionTitle}>{section}</Text>
                  {section === "Needs you" ? <Text type="supporting" xstyle={styles.saganCount}>{needsYouCount}</Text> : null}
                </HStack>
                {rows.length > 0 ? rows.map((run) => (
                  <SaganRow key={run.id} run={run} section={section} onSelect={selectRun} />
                )) : (
                  <Text type="supporting" xstyle={styles.saganEmpty}>No runs in this section.</Text>
                )}
              </VStack>
            );
          })}
        </>
      )}
    </VStack>
  );
}

export function V2TerminalSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [tid, setTid] = useState(() => crypto.randomUUID());
  const [exited, setExited] = useState(false);
  const killOnUnmount = useRef(true);
  if (!token) return <CenterState>Connecting to the shell…</CenterState>;
  if (exited) {
    return (
      <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
        <Text weight="semibold">Shell exited</Text>
        <Text color="secondary">Restart to open a fresh shell in this workspace.</Text>
        <Button
          label="Restart shell"
          icon={<RotateCcw size={16} aria-hidden />}
          variant="secondary"
          clickAction={() => {
            setTid(crypto.randomUUID());
            setExited(false);
          }}
        />
      </VStack>
    );
  }
  return (
    <VStack xstyle={[styles.body, styles.terminal]}>
      <TerminalEngine
        key={tid}
        token={token}
        theme="dark"
        tid={tid}
        mode="shell"
        cwd={cwd ?? undefined}
        closeOnUnmount={killOnUnmount}
        onExit={() => setExited(true)}
      />
    </VStack>
  );
}

/**
 * The Browser surface (WHA-109).
 *
 * Two things this must get right, both learned the hard way in v1
 * (`ui/src/components/BrowserSurface.tsx`, whose state machine this ports):
 *
 * 1. **Refusal is invisible client-side.** Chrome fires the iframe `load` event
 *    even for frames blocked by X-Frame-Options/CSP, deliberately, so you
 *    cannot tell "rendered" from "refused" from inside the page. The gateway
 *    probe (`GET /api/browser/probe`) reads the headers and answers honestly;
 *    without it this surface is a blank rectangle with no explanation.
 * 2. **The page is opaque to us.** Cross-origin means no title, no text, no
 *    selection — so the title shown here and reported to the agent comes from
 *    the gateway's own fetch (`GET /api/browser/read`), not from the frame.
 *
 * `onStateChange` is what makes the surface a context source: it reports the
 * live URL/title (or the failure) so a turn can carry the auto-context line.
 */
type BrowserView =
  | { kind: "empty" }
  | { kind: "checking"; url: string }
  | { kind: "ok"; url: string }
  | { kind: "refused"; url: string; reason: string | null }
  | { kind: "unreachable"; url: string; reason: string | null };

interface ProbeResult {
  reachable: boolean;
  frameable: boolean;
  reason: string | null;
  status: number | null;
}

/** Bare hosts ("localhost:5173") get a scheme; full URLs pass through. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).href;
  } catch {
    return null;
  }
}

/** Fallback grace for the iframe load event when the probe is unavailable. */
const LOAD_TIMEOUT_MS = 8_000;

export function V2BrowserSurface({
  token,
  active = false,
  onStateChange,
}: {
  token: string | null;
  /** True when Browser is the visible surface — gates the auto-context line. */
  active?: boolean;
  onStateChange?: (state: BrowserSurfaceReport) => void;
}) {
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<BrowserView>({ kind: "empty" });
  const [title, setTitle] = useState<string | null>(null);
  // Bumped per navigation so Refresh remounts the frame even for the same URL.
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  // A cross-origin frame fires `load` on every navigation inside it but never
  // tells us where it went (verified: the second load fires, reading
  // contentWindow.location throws). So we can know the user has moved off the
  // URL in the bar without knowing their new one — which is exactly enough to
  // stop describing the wrong page.
  const [navigatedAway, setNavigatedAway] = useState(false);
  const frameLoads = useRef(0);
  // WHA-38: the element the native view is glued to. Under Tauri the iframe is
  // never rendered — this placeholder just reserves the rect.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // Guards async probe/read results against a newer navigation having started.
  const navSeq = useRef(0);

  const navigate = useCallback(
    async (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      const seq = ++navSeq.current;
      setDraft(url);
      setTitle(null);
      setView({ kind: "checking", url });
      let probe: ProbeResult | null = null;
      try {
        const response = await fetch(
          `${apiBase()}/api/browser/probe?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(window.location.origin)}`,
          { headers: { "x-conan-token": token ?? "" } },
        );
        if (response.ok) probe = (await response.json()) as ProbeResult;
      } catch {
        // Probe unavailable (stale gateway) — fall through to the load-timeout
        // heuristic, which is the only signal left in that case.
      }
      if (seq !== navSeq.current) return;
      // Unreachable is real whatever renders it — a dead host is a dead host.
      if (probe && !probe.reachable) {
        setView({ kind: "unreachable", url, reason: probe.reason });
        return;
      }
      // Frameability is an IFRAME question, and it must not gate a native view.
      // The probe asks "may localhost:5173 embed this?", which is meaningless
      // when the page is about to load in a top-level webview that no
      // `frame-ancestors` header applies to. Gating on it here is what made
      // espn.com refuse inside a browser perfectly capable of showing it.
      if (probe && !probe.frameable && !isTauri()) {
        setView({ kind: "refused", url, reason: probe.reason });
        return;
      }
      setFrameLoading(true);
      frameLoads.current = 0;
      setNavigatedAway(false);
      setFrameKey((key) => key + 1);
      setView({ kind: "ok", url });
      // The title can only come from the gateway — a cross-origin frame will
      // not give it up. Best-effort: a failed read just leaves the URL alone.
      try {
        const response = await fetch(
          `${apiBase()}/api/browser/read?url=${encodeURIComponent(url)}`,
          { headers: { "x-conan-token": token ?? "" } },
        );
        if (response.ok) {
          const snapshot = (await response.json()) as { title?: string | null };
          if (seq === navSeq.current && snapshot.title) setTitle(snapshot.title);
        }
      } catch {
        // Title stays null; the surface and the agent both fall back to the URL.
      }
    },
    [token],
  );

  // Load-timeout heuristic: if the frame never fires `load`, stop claiming
  // progress. With the probe vetting first this is belt-and-braces; without it
  // (stale gateway) it is the only failure signal there is.
  useEffect(() => {
    // Iframe-only: with a native view there is no iframe to fire `load`, so
    // this heuristic would declare every page unreachable after the timeout.
    if (isTauri()) return;
    if (view.kind !== "ok" || !frameLoading) return;
    const url = view.url;
    const timer = setTimeout(() => {
      setFrameLoading(false);
      setView({ kind: "unreachable", url, reason: "the page never finished loading" });
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [view, frameLoading, frameKey]);

  // The native view supersedes the iframe wherever it exists. Everything the
  // iframe path has to guess at — did they navigate, where are they now — the
  // native view simply answers.
  const native = useNativeBrowser({
    anchor: anchorRef,
    url: view.kind === "ok" ? view.url : null,
    visible: active && view.kind === "ok",
  });

  // Report upward so the next turn can name this page. Failures report their
  // reason as `problem`, so the model is told the page did not load rather
  // than being handed a URL whose contents nobody can see.
  useEffect(() => {
    if (!onStateChange) return;
    const problem =
      view.kind === "refused" || view.kind === "unreachable"
        ? view.reason ?? "the page could not be displayed"
        : null;
    // With a native view the URL is authoritative — link clicks and SPA routing
    // both land in `native.url`, so `navigatedAway` (the iframe's "I've lost
    // track" flag) is permanently false and the agent gets the real page.
    const liveUrl = native.supported && native.url ? native.url : null;
    const staleUrl = view.kind === "empty" ? null : view.url;
    onStateChange({
      url: liveUrl ?? staleUrl,
      active,
      title: view.kind === "ok" && (native.supported || !navigatedAway) ? title : null,
      problem,
      navigatedAway: !native.supported && view.kind === "ok" && navigatedAway,
      // `checking` reports as loading rather than as a live page: the probe has
      // no verdict yet, and a turn sent inside that window must not be told a
      // page is on screen that may still resolve to a refusal.
      loading: view.kind === "checking",
    });
  }, [view, title, active, navigatedAway, native.supported, native.url, onStateChange]);

  const currentUrl = view.kind === "empty" ? null : view.url;
  const go = useCallback(() => void navigate(draft), [draft, navigate]);

  // WHA-120 — the page reads through the glass only on the IFRAME path.
  //
  // Where the native child webview is available (WHA-38, the Tauri app) it is
  // composited ABOVE the DOM: it cannot be blurred, and stretching its anchor
  // under the bar would paint an opaque native rectangle straight over the
  // pane's frosted header, hiding Actions / Open / Commit & Push entirely.
  // So the app keeps the inset layout and only the browser preview goes
  // full-bleed. The two DO diverge; that is a property of the native view, not
  // a shortcut. Flagged to Randy rather than shipped quietly.
  const readsThroughGlass = !native.supported;

  return (
    <VStack
      gap={3}
      xstyle={[styles.body, styles.padded, readsThroughGlass && styles.overlayBody]}
    >
      <HStack
        gap={2}
        align="end"
        xstyle={readsThroughGlass && [styles.browserBar, styles.glassHeader]}
      >
        <TextInput
          label="URL"
          isLabelHidden
          value={draft}
          placeholder="localhost:5173 or https://…"
          onChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") go();
          }}
          width="100%"
        />
        <Button label="Open" variant="secondary" clickAction={go} />
        <Button
          label="Refresh"
          icon={<RotateCcw size={16} aria-hidden />}
          variant="ghost"
          isDisabled={!currentUrl}
          clickAction={() => {
            if (currentUrl) void navigate(currentUrl);
          }}
        />
      </HStack>

      {view.kind === "empty" ? (
        <CenterState>Enter a URL to preview it inside Conan.</CenterState>
      ) : null}

      {view.kind === "checking" ? (
        <VStack align="center" justify="center" xstyle={styles.body}>
          <Spinner label={`Checking ${view.url}`} />
        </VStack>
      ) : null}

      {view.kind === "refused" ? (
        <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
          <Text weight="semibold">This site refuses to be embedded</Text>
          <Text color="secondary">
            {view.reason ? `${view.reason}.` : "Its headers forbid framing."} Conan previews
            local apps — full-site browsing needs the native webview.
          </Text>
          <Button
            label="Open in system browser"
            icon={<ExternalLink size={16} aria-hidden />}
            variant="secondary"
            clickAction={() => {
              window.open(view.url, "_blank", "noopener,noreferrer");
            }}
          />
        </VStack>
      ) : null}

      {view.kind === "unreachable" ? (
        <VStack align="center" justify="center" gap={3} xstyle={[styles.body, styles.padded]}>
          <Text weight="semibold">Couldn't reach that URL</Text>
          <Text color="secondary">
            {view.url}
            {view.reason ? ` — ${view.reason}` : ""}
          </Text>
          <Button
            label="Retry"
            icon={<RotateCcw size={16} aria-hidden />}
            variant="secondary"
            clickAction={() => void navigate(view.url)}
          />
        </VStack>
      ) : null}

      {/* Randy's report: the URL bar silently kept showing the page he STARTED
          on after he followed links inside Wikipedia. We cannot read the new
          URL from a cross-origin frame, so the fix is to stop implying we
          know it — say so to the user, and to the agent (navigatedAway). */}
      {view.kind === "ok" && navigatedAway && !native.supported ? (
        <VStack xstyle={styles.staleNotice} data-slot="browser-stale-url">
          <Text type="supporting" color="secondary">
            You've followed a link inside this page. Conan can't read the current
            address — the bar still shows where you started. Paste the page's URL
            above to re-sync it, and to let the agent read it.
          </Text>
        </VStack>
      ) : null}

      {view.kind === "ok" && native.supported ? (
        // The native view paints itself over this rect — nothing renders here.
        // It is a plain div on purpose: an Astryx component would be a layout
        // participant we'd then have to reason about when measuring.
        <div ref={anchorRef} data-slot="browser-native-anchor" {...stylex.props(styles.fill)} />
      ) : null}

      {view.kind === "ok" && !native.supported ? (
        <VStack xstyle={[styles.fill, styles.frameFill]}>
          <iframe
            key={frameKey}
            src={view.url}
            title={title ?? "Browser surface"}
            onLoad={() => {
              setFrameLoading(false);
              // The first load is the URL we asked for; any later one is the
              // user following a link inside the page.
              frameLoads.current += 1;
              if (frameLoads.current > 1) setNavigatedAway(true);
            }}
            {...stylex.props(styles.frame)}
          />
        </VStack>
      ) : null}
    </VStack>
  );
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}
interface FileListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  error?: string;
}

export function V2FilesSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [cache, setCache] = useState<Record<string, FileListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [directoryErrors, setDirectoryErrors] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [statusByPath, setStatusByPath] = useState<Map<string, FileStatus>>(new Map());

  const loadDirectory = useCallback(async (path: string) => {
    if (!token) return;
    setDirectoryErrors((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    try {
      const response = await fetch(apiBase() + `/api/fs/list?path=${encodeURIComponent(path)}`, {
        headers: { "x-conan-token": token },
      });
      if (!response.ok) throw new Error("Could not read folder.");
      const data = (await response.json()) as FileListing;
      setCache((current) => ({ ...current, [data.path]: data }));
    } catch {
      setDirectoryErrors((current) => new Set(current).add(path));
    }
  }, [token]);

  const loadRoot = useCallback(() => {
    if (!token || !cwd) return;
    let cancelled = false;
    setListing(null);
    setPreview(null);
    setExpanded(new Set());
    setDirectoryErrors(new Set());
    Promise.all([
      fetch(apiBase() + `/api/fs/list?path=${encodeURIComponent(cwd)}`, {
        headers: { "x-conan-token": token },
      }).then((response) => {
        if (!response.ok) throw new Error("Could not read folder.");
        return response.json() as Promise<FileListing>;
      }),
      fetch(apiBase() + "/api/fs/diff", {
        method: "POST",
        headers: { "content-type": "application/json", "x-conan-token": token },
        body: JSON.stringify({ cwd }),
      }).then((response) => {
        if (!response.ok) throw new Error("Could not load changes.");
        return response.json() as Promise<DiffResult>;
      }),
    ])
      .then(([root, diff]) => {
        if (cancelled) return;
        setListing(root);
        setCache({ [root.path]: root });
        const statuses = new Map<string, FileStatus>();
        if (diff.root) {
          for (const file of diff.files) {
            statuses.set(`${diff.root.replace(/\/$/, "")}/${file.path}`, file.status);
          }
        }
        setStatusByPath(statuses);
      })
      .catch(() => {
        if (!cancelled) {
          setListing({ path: cwd, parent: null, entries: [], error: "Could not read folder." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, token]);

  useEffect(() => loadRoot(), [loadRoot]);

  const openFile = useCallback(
    async (entry: FileTreeNode) => {
      if (!token) return;
      const response = await fetch(
        apiBase() + `/api/fs/read?path=${encodeURIComponent(entry.path)}`,
        { headers: { "x-conan-token": token } },
      );
      const data = (await response.json()) as { content?: string };
      setPreview({ path: entry.path, content: data.content ?? "This file cannot be previewed." });
    },
    [token],
  );
  const nodes = useMemo(() => {
    const makeNodes = (current: FileListing | undefined): FileTreeNode[] =>
      current?.entries.map((entry) => {
        const directStatus = statusByPath.get(entry.path);
        const childStatuses = [...statusByPath.entries()]
          .filter(([changedPath]) => changedPath.startsWith(`${entry.path}/`))
          .map(([, status]) => status);
        const status = directStatus ?? rollupFileStatus(childStatuses);
        return {
          id: entry.path,
          name: entry.name,
          path: entry.path,
          isDir: entry.isDir,
          status,
          children: entry.isDir ? makeNodes(cache[entry.path]) : undefined,
        };
      }) ?? [];
    return makeNodes(listing ?? undefined);
  }, [cache, listing, statusByPath]);

  if (!token || !cwd) return <CenterState>Select a thread to browse its files.</CenterState>;
  if (!listing) return <CenterState>Loading files…</CenterState>;
  return (
    <VStack xstyle={[styles.body, styles.overlayBody]}>
      <div {...stylex.props(styles.surfaceHeader, styles.glassHeader)}>
        {preview ? (
          <button type="button" aria-label="Back to files" onClick={() => setPreview(null)} {...stylex.props(styles.iconButton)}>
            <ArrowLeft size={16} aria-hidden />
          </button>
        ) : <Folder size={16} aria-hidden />}
        <span title={preview?.path ?? listing.path} {...stylex.props(styles.headerPath)}>
          <Text type="supporting" color="secondary">{preview?.path ?? listing.path}</Text>
        </span>
        {!preview ? (
          <button type="button" aria-label="Refresh files" onClick={loadRoot} {...stylex.props(styles.iconButton)}>
            <RefreshCw size={16} aria-hidden />
          </button>
        ) : null}
      </div>
      {preview ? (
        <VStack xstyle={[styles.fill, styles.padded]}>
          <Text xstyle={styles.preview}>{preview.content}</Text>
        </VStack>
      ) : listing.error ? (
        <CenterState>{listing.error}</CenterState>
      ) : (
        <div {...stylex.props(styles.treeScroller, styles.overlayScroller)}>
          <V2FileTree
            label="Workspace files"
            nodes={nodes}
            expanded={expanded}
            onToggle={(node) => {
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(node.id)) next.delete(node.id);
                else {
                  next.add(node.id);
                  if (!cache[node.path]) void loadDirectory(node.path);
                }
                return next;
              });
            }}
            onOpenFile={(node) => void openFile(node)}
            renderTrailing={(node) => directoryErrors.has(node.path) ? (
              <span role="status" {...stylex.props(styles.inlineError)}>Couldn’t load</span>
            ) : null}
          />
        </div>
      )}
    </VStack>
  );
}

interface DiffFile {
  path: string;
  patch: string;
  status: FileStatus;
  truncated: boolean;
}

interface DiffResult { repo: boolean; root: string | null; files: DiffFile[] }

export function V2DiffSurface({ token, cwd }: { token: string | null; cwd: string | null }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token || !cwd) return;
    let cancelled = false;
    setFiles(null);
    setError(null);
    fetch(apiBase() + "/api/fs/diff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-conan-token": token },
      body: JSON.stringify({ cwd }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load changes.");
        return response.json() as Promise<{ repo: boolean; files: DiffFile[] }>;
      })
      .then((data) => {
        if (!cancelled) setFiles(data.files);
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, token]);
  const parsed = useMemo(
    () => files?.map((file) => ({ ...file, diff: parseUnifiedPatch(file.path, file.patch) })),
    [files],
  );
  const tree = useMemo(() => buildFileTree(parsed ?? []), [parsed]);
  const byPath = useMemo(() => new Map(parsed?.map((file) => [file.path, file]) ?? []), [parsed]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const folderIds: string[] = [];
    const collect = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
      if (node.isDir) folderIds.push(node.id);
      if (node.children) collect(node.children);
    });
    collect(tree);
    setExpanded(new Set(folderIds));
  }, [tree]);
  if (!token || !cwd) return <CenterState>Select a thread to review changes.</CenterState>;
  if (error) return <CenterState>{error}</CenterState>;
  if (!parsed) {
    return (
      <VStack align="center" justify="center" xstyle={styles.body}>
        <Spinner label="Loading changes" />
      </VStack>
    );
  }
  if (parsed.length === 0) return <CenterState>No uncommitted changes.</CenterState>;
  const aggregate = (node: FileTreeNode): { added: number; removed: number } => {
    const file = byPath.get(node.path);
    if (file) return { added: file.diff.added, removed: file.diff.removed };
    return (node.children ?? []).reduce(
      (total, child) => {
        const counts = aggregate(child);
        return { added: total.added + counts.added, removed: total.removed + counts.removed };
      },
      { added: 0, removed: 0 },
    );
  };
  return (
    <VStack xstyle={[styles.body, styles.overlayBody]}>
      <div {...stylex.props(styles.surfaceHeader, styles.glassHeader)}>
        <Text type="supporting" color="secondary">Uncommitted changes</Text>
        <span {...stylex.props(styles.count)}><Text type="supporting" hasTabularNumbers>{parsed.length}</Text></span>
      </div>
      <div {...stylex.props(styles.treeScroller, styles.overlayScroller)}>
        <V2FileTree
          label="Changed files"
          nodes={tree}
          expanded={expanded}
          onToggle={(node) => setExpanded((current) => {
            const next = new Set(current);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
          })}
          onOpenFile={() => {}}
          renderTrailing={(node) => {
            const counts = aggregate(node);
            return (
              <span {...stylex.props(styles.stat)}>
                <span {...stylex.props(styles.statAdd)}>+{counts.added}</span>
                <span aria-hidden {...stylex.props(styles.statDivider)}>/</span>
                <span {...stylex.props(styles.statDel)}>−{counts.removed}</span>
              </span>
            );
          }}
          renderExpandedFile={(node) => {
            const file = byPath.get(node.path);
            return file ? <V2DiffView diff={file.diff} /> : null;
          }}
        />
      </div>
    </VStack>
  );
}
