import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.ts";
import { useGateway, type ConnStatus } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useUsage } from "./hooks/useUsage.ts";
import { useTerminals } from "./hooks/useTerminals.ts";
import TerminalPane from "./components/TerminalPane.tsx";
import Hud from "./components/Hud.tsx";
import { usePulse } from "./hooks/usePulse.ts";
import { useWidgets } from "./hooks/useWidgets.ts";
import Toaster from "./components/Toaster.tsx";
import { apiBase } from "./lib/gateway.ts";

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
  const [hudOpen, setHudOpen] = useState(true);
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
  // US-030: usage monitor — cost/tokens today + rate-limit state & reset time.
  // US-025: also surfaces the real /usage scrape; token-gated probe on open.
  const usage = useUsage(wsTrigger, config?.token ?? null);
  // US-020: time-series throughput across sessions for the Pulse chart.
  const [pulseMinutes, setPulseMinutes] = useState(60);
  const pulse = usePulse(wsTrigger, pulseMinutes);
  // US-004: the Context widget's live breakdown for the active session. Always
  // fetched (the Context HUD tab is permanent now) when a session is correlated.
  const widgetData = useWidgets(activeSession?.id ?? null, wsTrigger, true);

  useEffect(() => {
    fetch(apiBase() + "/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    fetch(apiBase() + "/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          Conan
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
            onClick={() => setHudOpen((v) => !v)}
            title="Toggle the widget HUD"
            className="rounded-md border border-border px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            {hudOpen ? "Hide HUD" : "Show HUD"}
          </button>
        </div>
      </header>

      {/* Terminal-primary shell (US-003): the Claude Code terminal fills the
          main area; the DevTools-style HUD docks to its right (drag-resizable,
          width persisted). The HUD stays mounted when hidden so its tab state
          survives the toggle; terminals always stay mounted so ptys survive. */}
      <div className="flex min-h-0 flex-1">
        <TerminalPane token={config?.token ?? null} theme={theme} />
        <Hud
          hidden={!hudOpen}
          activeSession={activeSession}
          data={widgetData}
          usage={usage}
          pulse={pulse}
          pulseMinutes={pulseMinutes}
          onPulseRange={setPulseMinutes}
        />
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
