import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.ts";
import { useGateway, type ConnStatus } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useSkills } from "./hooks/useSkills.ts";
import { useSessionEvents } from "./hooks/useSessionEvents.ts";
import { usePendingPermissions } from "./hooks/usePendingPermissions.ts";
import Dock from "./components/Dock.tsx";
import SessionGrid from "./components/SessionGrid.tsx";
import HeroWidgets from "./components/HeroWidgets.tsx";
import PendingApprovals from "./components/PendingApprovals.tsx";
import ActivityTimeline from "./components/ActivityTimeline.tsx";
import TranscriptViewer from "./components/TranscriptViewer.tsx";
import { useTranscript } from "./hooks/useTranscript.ts";
import Toaster from "./components/Toaster.tsx";

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
  const skills = useSkills(activeSession?.id ?? null, wsTrigger);
  // Timeline (US-011): events for the selected session — history + live WS.
  const timelineEvents = useSessionEvents(selectedId, lastEvent);
  // Transcript (US-014): fetched lazily, only while its tab is open.
  const transcript = useTranscript(selectedId, detailTab === "transcript");
  const selectedSession = sessions.find((s) => s.id === selectedId) ?? null;
  // US-013: every pending permission prompt across sessions, kept live by WS.
  const { pending, refresh: refreshPending } = usePendingPermissions(wsTrigger);

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

  // US-012: the timeline decides for whichever session it's showing.
  const decidePermission = (requestId: string | null, choice: "allow" | "deny") => {
    if (!selectedId) return;
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
    <div className="flex h-full flex-col bg-background text-foreground">
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-lg font-semibold tracking-tight">Conan</span>
          {config?.cwd && (
            <span
              title={config.cwd}
              className="hidden min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground sm:flex"
            >
              <FolderIcon />
              <span className="truncate">{prettyPath(config.cwd)}</span>
            </span>
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
        <main className="min-w-0 flex-1 overflow-auto p-6">
          <HeroWidgets
            sessions={sessions}
            activeSession={activeSession}
            skills={skills}
          />

          <div className="mt-4">
            <PendingApprovals pending={pending} onDecide={postDecision} />
          </div>

          <SessionGrid
            sessions={sessions}
            token={config?.token ?? null}
            defaultCwd={config?.cwd ?? ""}
            onRefresh={refresh}
            selectedId={selectedId}
            onSelect={(id) =>
              setSelectedId((cur) => (cur === id ? null : id))
            }
          />

          {selectedId && (
            <section className="mt-6">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex rounded-md border border-border bg-card p-0.5 text-xs">
                    {(["activity", "transcript"] as const).map((tab) => (
                      <button
                        key={tab}
                        onClick={() => setDetailTab(tab)}
                        className={
                          "rounded px-2.5 py-1 capitalize " +
                          (detailTab === tab
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted")
                        }
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {selectedSession?.title ??
                      selectedSession?.model ??
                      selectedId.slice(0, 8)}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedId(null)}
                  className="shrink-0 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  Close
                </button>
              </div>
              {detailTab === "activity" ? (
                <ActivityTimeline
                  events={timelineEvents}
                  onDecide={decidePermission}
                />
              ) : (
                <TranscriptViewer state={transcript} />
              )}
            </section>
          )}
        </main>

        {dockOpen && (
          <Dock token={config?.token ?? null} theme={theme} tasks={tasks} />
        )}
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

/** Abbreviate $HOME to ~ for a compact toolbar path. */
function prettyPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split("/");
    if (rest.length > 1) return "~/" + rest.slice(1).join("/");
  }
  return p;
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}
