import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.ts";
import { useGateway } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useUsage } from "./hooks/useUsage.ts";
import { useTerminals } from "./hooks/useTerminals.ts";
import TerminalPane from "./components/TerminalPane.tsx";
import Hud from "./components/Hud.tsx";
import { usePulse } from "./hooks/usePulse.ts";
import { useWidgets } from "./hooks/useWidgets.ts";
import Toaster from "./components/Toaster.tsx";
import { apiBase } from "./lib/gateway.ts";
import { installAppMenu } from "./lib/appMenu.ts";

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
  // US-010: bind the live /usage capture (Session block + 3 windows) to the
  // active session via the session id; refetch drives the on-demand Refresh.
  const { usage, refetch: refetchUsage } = useUsage(
    wsTrigger,
    config?.token ?? null,
    activeSession?.id ?? null,
  );
  // US-020: time-series throughput across sessions for the Pulse chart.
  const [pulseMinutes, setPulseMinutes] = useState(60);
  const pulse = usePulse(wsTrigger, pulseMinutes);
  // US-004: the Context widget's live breakdown for the active session. Always
  // fetched (the Context HUD tab is permanent now) when a session is correlated.
  const { data: widgetData, refetch: refetchWidgets } = useWidgets(
    activeSession?.id ?? null,
    wsTrigger,
    true,
  );

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

  // Native macOS menu bar (Tauri only) — File/Edit/View/Help. The View toggles
  // (theme, HUD) live here now that the top toolbar is gone; File items dispatch
  // window events TerminalPane handles. Rebuilt on theme/HUD change so the
  // toggle labels stay accurate. No-op in the browser dev/web view.
  useEffect(() => {
    installAppMenu({
      theme,
      hudOpen,
      onToggleTheme: toggle,
      onToggleHud: () => setHudOpen((v) => !v),
      onNewTerminal: () =>
        window.dispatchEvent(new CustomEvent("conan:new-terminal")),
      onCloseTerminal: () =>
        window.dispatchEvent(new CustomEvent("conan:close-terminal")),
    }).catch(() => {});
  }, [theme, hudOpen, toggle]);

  return (
    // Terminal-primary shell (US-003): no top toolbar — the Claude Code terminal
    // fills the main area and the DevTools-style HUD docks to its right
    // (drag-resizable, width persisted). View/theme/HUD controls live in the
    // native macOS menu bar (installAppMenu above); the gateway status lives in
    // the HUD tab bar. The HUD stays mounted when hidden so its tab state
    // survives the toggle; terminals always stay mounted so ptys survive.
    <div className="flex h-full bg-background text-foreground">
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <TerminalPane token={config?.token ?? null} theme={theme} />
      <Hud
        hidden={!hudOpen}
        status={status}
        port={health?.port ?? config?.port}
        activeSession={activeSession}
        data={widgetData}
        token={config?.token ?? null}
        onRefetchWidgets={refetchWidgets}
        usage={usage}
        onRefetchUsage={refetchUsage}
        pulse={pulse}
        pulseMinutes={pulseMinutes}
        onPulseRange={setPulseMinutes}
      />
    </div>
  );
}
