import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.ts";
import { useGateway, type ConnStatus } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useSkills } from "./hooks/useSkills.ts";
import { useUsage } from "./hooks/useUsage.ts";
import { useMcp } from "./hooks/useMcp.ts";
import { useStats } from "./hooks/useStats.ts";
import { useSessionEvents, ALL_SESSIONS } from "./hooks/useSessionEvents.ts";
import { usePendingPermissions } from "./hooks/usePendingPermissions.ts";
import Dock from "./components/Dock.tsx";
import SessionBar from "./components/SessionBar.tsx";
import Widgets from "./components/Widgets.tsx";
import PendingApprovals from "./components/PendingApprovals.tsx";
import PulseChart from "./components/PulseChart.tsx";
import { usePulse } from "./hooks/usePulse.ts";
import { useWidgets } from "./hooks/useWidgets.ts";
import { useCwdGit } from "./hooks/useCwdGit.ts";
import { useProjectMetrics } from "./hooks/useProjectMetrics.ts";
import { useWidgetPrefs } from "./hooks/useWidgetPrefs.ts";
import ActivityTimeline from "./components/ActivityTimeline.tsx";
import TranscriptViewer from "./components/TranscriptViewer.tsx";
import { useTranscript } from "./hooks/useTranscript.ts";
import Toaster from "./components/Toaster.tsx";
import Sidebar from "./components/Sidebar.tsx";
import SettingsView from "./components/SettingsView.tsx";
import AgentsView from "./components/AgentsView.tsx";
import SkillsView from "./components/SkillsView.tsx";
import WhatsNewView from "./components/WhatsNewView.tsx";
import CwdPicker from "./components/CwdPicker.tsx";
import { useRoute } from "./hooks/useRoute.ts";
import { useChangelog } from "./hooks/useChangelog.ts";

interface Health {
  status: string;
  port: number;
  tables: string[];
}

interface Config {
  token: string;
  port: number;
  cwd: string;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // US-006: pushState routing (Overview / Settings) + collapsible sidebar whose
  // collapsed state survives reloads.
  const { route, navigate } = useRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("conan.sidebar.collapsed") === "1",
  );
  const toggleSidebar = () =>
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem("conan.sidebar.collapsed", next ? "1" : "0");
      return next;
    });
  // Which tab the selected-session detail shows (US-011 vs US-014).
  const [detailTab, setDetailTab] = useState<"activity" | "transcript">(
    "activity",
  );
  const { theme, toggle } = useTheme();
  // Re-subscribe to whichever session's timeline is open so its events replay
  // after a reconnect (US-018).
  const { tasks, lastEvent, status, reconnectSeq } = useGateway(
    config?.token ?? null,
    selectedId ? [selectedId] : [],
  );
  // A trigger that advances on each live event *and* each reconnect, so the
  // REST-backed hooks re-pull their snapshots after a connection gap.
  const wsTrigger = (lastEvent?.seq ?? 0) + reconnectSeq;
  const { sessions, refresh } = useSessions(wsTrigger);
  // The Context/Skills widgets describe the active session: a running one if
  // present, otherwise the most-recently-active (sessions are sorted DESC).
  const activeSession =
    sessions.find((s) => s.status === "running") ?? sessions[0] ?? null;
  // US-019: the session-scoped widgets (Context, Model, Skills) describe whichever
  // session the timeline ▾ has selected, falling back to the auto active session
  // when "All sessions"/nothing is picked — so they update as the ▾ changes.
  const selectedSession = sessions.find((s) => s.id === selectedId) ?? null;
  const widgetSession =
    selectedId && selectedId !== ALL_SESSIONS
      ? (selectedSession ?? activeSession)
      : activeSession;
  const skills = useSkills(widgetSession?.id ?? null, wsTrigger);
  // US-030: usage monitor — cost/tokens today + rate-limit state & reset time.
  // US-025: also surfaces the real /usage scrape; token-gated probe on open.
  const usage = useUsage(wsTrigger, config?.token ?? null);
  // US-011: MCP server status — inferred connected count + names + needs-auth.
  const mcp = useMcp(wsTrigger);
  // US-015: Claude Code's own usage rollup — contribution heatmap + headline stats.
  const stats = useStats(wsTrigger);
  // US-030: What's New changelog feed + unseen-entry count for the nav badge.
  const changelog = useChangelog(wsTrigger);
  // US-007: the timeline is the primary surface. Default the session ▾ to the
  // most-recent active session once sessions load; "All sessions" (and any
  // explicit pick) is sticky thereafter.
  useEffect(() => {
    if (selectedId === null && activeSession) setSelectedId(activeSession.id);
  }, [selectedId, activeSession]);
  const isAll = selectedId === ALL_SESSIONS;
  // Transcript is per-session; "All sessions" only has an Activity view.
  const effectiveTab = isAll ? "activity" : detailTab;
  // Timeline (US-011): events for the selected session — history + live WS.
  const timelineEvents = useSessionEvents(selectedId, lastEvent);
  // Transcript (US-014): fetched lazily, only while its tab is open.
  const transcript = useTranscript(
    isAll ? null : selectedId,
    effectiveTab === "transcript",
  );
  // US-013: every pending permission prompt across sessions, kept live by WS.
  const { pending, refresh: refreshPending } = usePendingPermissions(wsTrigger);
  // US-020: time-series throughput across sessions for the Pulse chart.
  const [pulseMinutes, setPulseMinutes] = useState(60);
  const pulse = usePulse(wsTrigger, pulseMinutes);
  // US-022: opt-in secondary widgets. Data is fetched for the active session
  // only when at least one widget is enabled, keeping the default view lean.
  const widgetPrefs = useWidgetPrefs();
  const widgetData = useWidgets(
    widgetSession?.id ?? null,
    wsTrigger,
    widgetPrefs.anyEnabled,
  );
  // US-019: Git is cwd-scoped — it follows the active working directory (the
  // toolbar cwd), not a session's cwd. Refetched on each WS event.
  const cwdGit = useCwdGit(
    config?.cwd ?? null,
    wsTrigger,
    widgetPrefs.anyEnabled,
  );
  // US-026: Last-session metrics are also cwd-scoped — they read the figures
  // Claude Code recorded for the active working directory's project.
  const projectMetrics = useProjectMetrics(
    config?.cwd ?? null,
    wsTrigger,
    widgetPrefs.anyEnabled,
  );

  // Route an approve/deny choice to a session via the US-012 decision route,
  // then refresh the cross-session pending list. Shared by the inline timeline
  // control and the pending-approvals widget (US-013).
  const postDecision = (
    sessionId: string,
    requestId: string | null,
    choice: "allow" | "deny",
  ) => {
    if (!config?.token) return;
    fetch(`/api/claude/sessions/${encodeURIComponent(sessionId)}/permission`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conan-token": config.token,
      },
      body: JSON.stringify({ request_id: requestId, decision: choice }),
    })
      .then(() => refreshPending())
      .catch(() => {});
  };

  // US-012: the timeline decides for whichever session it's showing. In the
  // "All sessions" view there is no single target — the PendingApprovals panel
  // handles cross-session decisions with the correct session id.
  const decidePermission = (requestId: string | null, choice: "allow" | "deny") => {
    if (!selectedId || selectedId === ALL_SESSIONS) return;
    postDecision(selectedId, requestId, choice);
  };

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  return (
    <div className="flex h-full bg-background text-foreground">
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <Sidebar
        route={route}
        onNavigate={navigate}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        whatsNewBadge={changelog.unseenCount}
      />
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {config?.cwd && (
            <CwdPicker
              cwd={config.cwd}
              token={config.token}
              onChange={(cwd) =>
                setConfig((c) => (c ? { ...c, cwd } : c))
              }
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          <ConnectionStatus status={status} port={health?.port ?? config?.port} />
          <button
            onClick={toggle}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            {theme === "dark" ? "☾ Dark" : "☀ Light"}
          </button>
          <button
            onClick={() => setDockOpen((v) => !v)}
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            {dockOpen ? "Hide terminal" : "Show terminal"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* US-020: top padding lives on the content, not <main>, so the sticky
            widget row (Overview) can pin its opaque background flush to the
            scrollport top with no transparent gap for the timeline to show
            through. Non-Overview routes get the padding back via pt-6. */}
        <main className="min-w-0 flex-1 overflow-auto px-6 pb-6">
          {route === "settings" ? (
            <div className="pt-6">
              <SettingsView
                theme={theme}
                onToggleTheme={toggle}
                token={config?.token ?? null}
              />
            </div>
          ) : route === "agents" ? (
            <div className="pt-6">
              <AgentsView token={config?.token ?? null} trigger={wsTrigger} />
            </div>
          ) : route === "skills" ? (
            <div className="pt-6">
              <SkillsView
                sessionId={widgetSession?.id ?? null}
                cwd={config?.cwd ?? null}
                trigger={wsTrigger}
              />
            </div>
          ) : route === "whatsnew" ? (
            <div className="pt-6">
              <WhatsNewView changelog={changelog} />
            </div>
          ) : (
          <>
          <Widgets
            sessions={sessions}
            activeSession={widgetSession}
            skills={skills}
            usage={usage}
            mcp={mcp}
            stats={stats}
            data={widgetData}
            git={cwdGit}
            metrics={projectMetrics}
            enabled={widgetPrefs.enabled}
            toggle={widgetPrefs.toggle}
          />

          <PendingApprovals pending={pending} onDecide={postDecision} />

          <div className="mt-4">
            <PulseChart
              series={pulse}
              minutes={pulseMinutes}
              onRange={setPulseMinutes}
            />
          </div>

          {/* US-007: timeline-primary Overview — session ▾ + inline lifecycle
              controls replace the removed per-session card grid. */}
          <section className="mt-6">
            <SessionBar
              sessions={sessions}
              token={config?.token ?? null}
              defaultCwd={config?.cwd ?? ""}
              onRefresh={refresh}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={() => setDockOpen(true)}
            />

            <div className="mb-3 flex items-center gap-3">
              <div className="flex rounded-md border border-border bg-card p-0.5 text-xs">
                {(["activity", "transcript"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setDetailTab(tab)}
                    disabled={isAll && tab === "transcript"}
                    className={
                      "rounded px-2.5 py-1 capitalize disabled:opacity-40 " +
                      (effectiveTab === tab
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted")
                    }
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {isAll
                  ? "All sessions"
                  : (selectedSession?.title ??
                    selectedSession?.model ??
                    selectedId?.slice(0, 8) ??
                    "no session")}
              </span>
            </div>

            {effectiveTab === "activity" ? (
              <ActivityTimeline
                events={timelineEvents}
                onDecide={decidePermission}
              />
            ) : (
              <TranscriptViewer state={transcript} />
            )}
          </section>
          </>
          )}
        </main>

        {dockOpen && (
          <Dock token={config?.token ?? null} theme={theme} tasks={tasks} />
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * Live WebSocket connection indicator (US-018). Reflects the self-healing app
 * socket: connected (green), connecting/reconnecting (amber, pulsing), or
 * offline (red) after backoff has given up reaching the gateway.
 */
function ConnectionStatus({
  status,
  port,
}: {
  status: ConnStatus;
  port?: number;
}) {
  const meta: Record<ConnStatus, { dot: string; text: string; label: string }> = {
    connected: {
      dot: "bg-primary",
      text: "text-primary",
      label: port ? `gateway :${port}` : "connected",
    },
    connecting: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-muted-foreground",
      label: "connecting…",
    },
    reconnecting: {
      dot: "bg-amber-500 animate-pulse",
      text: "text-muted-foreground",
      label: "reconnecting…",
    },
    offline: {
      dot: "bg-red-500",
      text: "text-red-500",
      label: "offline",
    },
  };
  const m = meta[status];
  return (
    <span
      title={`Gateway connection: ${status}`}
      className={"inline-flex items-center gap-1.5 " + m.text}
    >
      <span className={"size-2 rounded-full " + m.dot} />
      {m.label}
    </span>
  );
}
