import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.ts";
import { useGateway, type ConnStatus } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useSkills } from "./hooks/useSkills.ts";
import { useUsage } from "./hooks/useUsage.ts";
import { useMcp } from "./hooks/useMcp.ts";
import { useStats } from "./hooks/useStats.ts";
import { useTerminals } from "./hooks/useTerminals.ts";
import Dock from "./components/Dock.tsx";
import Widgets from "./components/Widgets.tsx";
import { usePulse } from "./hooks/usePulse.ts";
import { useWidgets } from "./hooks/useWidgets.ts";
import { useCwdGit } from "./hooks/useCwdGit.ts";
import { useProjectMetrics } from "./hooks/useProjectMetrics.ts";
import { useWidgetPrefs } from "./hooks/useWidgetPrefs.ts";
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
  const { theme, toggle } = useTheme();
  const { tasks, lastEvent, status, reconnectSeq } = useGateway(
    config?.token ?? null,
    [],
  );
  // A trigger that advances on each live event *and* each reconnect, so the
  // REST-backed hooks re-pull their snapshots after a connection gap.
  const wsTrigger = (lastEvent?.seq ?? 0) + reconnectSeq;
  const { sessions } = useSessions(wsTrigger);
  // US-006: the Claude session running inside a live dock pty, correlated by
  // src/terminal/correlate.ts and surfaced per-terminal over /api/terminals.
  // This is the session the user is *actually* running — the right binding for
  // the session-scoped widgets (Context, Model, Skills) instead of the first of
  // ~155 historical 'running' rows.
  const terminals = useTerminals();
  const correlatedSession = (() => {
    const matched = [...terminals.values()]
      .map((t) => t.sessionId)
      .filter((id): id is string => !!id)
      .map((id) => sessions.find((s) => s.id === id))
      .filter((s): s is (typeof sessions)[number] => !!s);
    return matched.find((s) => s.status === "running") ?? matched[0] ?? null;
  })();
  // The Context/Skills widgets describe the active session: the one correlated to
  // a live pty if present, otherwise a running one, otherwise the most-recently-
  // active (sessions are sorted DESC). Falls through to null when there are none.
  const activeSession =
    correlatedSession ??
    sessions.find((s) => s.status === "running") ??
    sessions[0] ??
    null;
  const skills = useSkills(activeSession?.id ?? null, wsTrigger);
  // US-030: usage monitor — cost/tokens today + rate-limit state & reset time.
  // US-025: also surfaces the real /usage scrape; token-gated probe on open.
  const usage = useUsage(wsTrigger, config?.token ?? null);
  // US-011: MCP server status — inferred connected count + names + needs-auth.
  const mcp = useMcp(wsTrigger);
  // US-015: Claude Code's own usage rollup — contribution heatmap + headline stats.
  const stats = useStats(wsTrigger);
  // US-020: time-series throughput across sessions for the Pulse chart.
  const [pulseMinutes, setPulseMinutes] = useState(60);
  const pulse = usePulse(wsTrigger, pulseMinutes);
  // US-022: opt-in secondary widgets. Data is fetched for the active session
  // only when at least one widget is enabled, keeping the default view lean.
  const widgetPrefs = useWidgetPrefs();
  const widgetData = useWidgets(
    activeSession?.id ?? null,
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
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2" />
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
        <main className="min-w-0 flex-1 overflow-auto px-6 pb-6">
          <Widgets
            sessions={sessions}
            activeSession={activeSession}
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
        </main>

        {/* The Dock stays mounted even when hidden so toggling the terminal off
            keeps every pty + WS alive (US-037): hide is purely visual, never a
            detach/kill. Only an explicit tab-close kills a pty. */}
        <Dock
          token={config?.token ?? null}
          theme={theme}
          tasks={tasks}
          hidden={!dockOpen}
          pulse={pulse}
          pulseMinutes={pulseMinutes}
          onPulseRange={setPulseMinutes}
        />
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
