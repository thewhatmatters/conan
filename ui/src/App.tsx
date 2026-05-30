import { useEffect, useState } from "react";
import { useThemes } from "./hooks/useThemes.ts";
import { useUserThemes } from "./hooks/useUserThemes.ts";
import { useGateway } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import { useUsage } from "./hooks/useUsage.ts";
import { useTerminals } from "./hooks/useTerminals.ts";
import TerminalPane from "./components/TerminalPane.tsx";
import Hud from "./components/Hud.tsx";
import { usePulse } from "./hooks/usePulse.ts";
import { useSkills } from "./hooks/useSkills.ts";
import { useConfig } from "./hooks/useConfig.ts";
import { useRadio } from "./hooks/useRadio.ts";
import { useDoctor } from "./hooks/useDoctor.ts";
import { useTier } from "./hooks/useTier.ts";
import { useWindowWidth } from "./hooks/useWindowWidth.ts";
import { useWindowHeight } from "./hooks/useWindowHeight.ts";

/** Window width at which the HUD reflows from a right dock to a bottom dock
 *  (US-025). Below this the terminal can't share horizontal space with a
 *  320px-min HUD, so instead of hiding it we stack: terminal on top, HUD
 *  docked to the bottom. The View ▸ HUD toggle (`hudOpen`) still hides it at
 *  any width and survives resizes so a wide window restores the user's intent. */
const HUD_BOTTOM_BREAKPOINT = 900;
import { useWidgets } from "./hooks/useWidgets.ts";
import Toaster from "./components/Toaster.tsx";
import SettingsView from "./components/SettingsView.tsx";
import UpdateBanner from "./components/UpdateBanner.tsx";
import Onboarding from "./components/Onboarding.tsx";
import { apiBase } from "./lib/gateway.ts";
import { installAppMenu } from "./lib/appMenu.ts";
import { useNativeNotifications } from "./hooks/useNativeNotifications.ts";

interface Config {
  token: string;
  port: number;
  cwd: string;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [hudOpen, setHudOpen] = useState(true);
  // Horizontal responsiveness: window-width-driven layout decisions live here
  // so both the HUD (bottom-docks when narrow) and TerminalPane (Timeline
  // overlays the terminal at very-narrow widths) agree on the same state.
  const windowWidth = useWindowWidth();
  // US-026: live window height feeds the bottom dock's short-window guard so
  // the terminal keeps a minimum height and the HUD clamps instead of becoming
  // an unusable sliver.
  const windowHeight = useWindowHeight();
  // US-025: below the breakpoint the shell stacks vertically — TerminalPane on
  // top, the HUD docked to the bottom (dock="bottom") — instead of the HUD
  // hiding. Wide windows keep the side-by-side right dock.
  const hudBottomDock = windowWidth < HUD_BOTTOM_BREAKPOINT;
  // US-008: the read-only Settings view, opened from Conan ▸ Settings (⌘,).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // US-102: the Timeline's Upgrade button dispatches `conan:open-settings`
  // with `{ detail: { tab: "license" } }` so the Free user lands directly on
  // the paste-your-license surface. Plain ⌘, opens with `undefined` and falls
  // through to the dialog's default tab (Status).
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "status" | "config" | "appearance" | "license" | undefined
  >(undefined);
  // US-023: the full theme set (built-ins + user themes from ~/.conan/themes.json)
  // and the active selection. useThemes registers the user themes into the shared
  // apply store, so selecting one — in the Appearance picker or the View ▸ Theme
  // menu — reskins app + terminal live and persists by id across reload. `theme`
  // (the resolved light/dark) still drives TerminalPane's xterm theme prop.
  const userThemes = useUserThemes(config?.token ?? null);
  const { themes, activeId, activeTheme, setActiveTheme } = useThemes(userThemes);
  const theme = activeTheme.type;
  const {
    tasks,
    lastEvent,
    lastSkillFired,
    lastSkillConsidered,
    lastPlan,
    lastRadio,
    lastUsageCapture,
    reconnectSeq,
  } = useGateway(config?.token ?? null, []);
  // A trigger that advances on each live event *and* each reconnect, so the
  // REST-backed hooks re-pull their snapshots after a connection gap. We also
  // fold in `lastUsageCapture.seq` so a passively-captured /usage frame (no
  // hook event fires) still kicks useUsage into refetching — the trigger that
  // makes a user-typed `/usage` populate the HUD without a manual ↻ click.
  const wsTrigger =
    (lastEvent?.seq ?? 0) + reconnectSeq + (lastUsageCapture?.seq ?? 0);
  const { sessions } = useSessions(wsTrigger);
  // US-006/US-003: the Claude session running inside a live dock pty, correlated
  // by src/terminal/correlate.ts and surfaced per-terminal over /api/terminals.
  // This is the session the user is *actually* running — the right binding for
  // the session-scoped widgets (Context, Plan, Skills) instead of the first of
  // ~155 historical 'running' rows.
  const terminals = useTerminals();
  // US-003: the tid of the terminal tab the user is currently looking at,
  // reported up from TerminalPane on mount / tab switch / new / close.
  const [activeTid, setActiveTid] = useState<string | null>(null);
  // The HUD's session-scoped widgets describe the session correlated to the
  // ACTIVE tab — `activeTid → sessionId` via useTerminals — so opening a new
  // terminal repoints them instead of clinging to the previous session. A fresh
  // tab whose pty hasn't correlated yet has no session id, so activeSession is
  // null (empty/uncorrelated state) rather than the prior tab's data.
  const activeSessionId = activeTid
    ? terminals.get(activeTid)?.sessionId ?? null
    : null;
  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId) ?? null
    : null;
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
  // US-006: installed skills (name + description + source) for the Skills tab.
  const skills = useSkills(config?.token ?? null);
  // US-008: Claude Code's config mirror for the Settings view; refetch re-reads
  // after the Config tab writes a key (US-010) so the saved value sticks.
  const [claudeConfig, refetchConfig] = useConfig(config?.token ?? null);
  // Claude Radio: current { videoId, title } the bottom-of-HUD player is
  // pointed at. Drives RadioBar's player + label; live-updated by the
  // bundled /conan-change-radio skill via {type:'radio'} broadcasts.
  const radio = useRadio(config?.token ?? null, wsTrigger, lastRadio);
  // Probe whether the user has Claude Code installed (src/doctor/claude.ts).
  // Drives the install banner above the terminal + the Settings ▸ Status line.
  // Backend caches 10min so this is cheap.
  const doctor = useDoctor(config?.token ?? null);
  // US-101: Premium tier hook — boots once when the token arrives, then every
  // gated surface reads `useTier()` to flip Free ↔ Premium. Idempotent.
  useTier(config?.token ?? null);
  // US-011: native macOS notifications for Claude's `Notification` hook prompts.
  // The correlated live-pty session is the one whose terminal is visible, so a
  // prompt for it while Conan is focused is suppressed (the user sees it live).
  useNativeNotifications({
    lastEvent,
    sessions,
    visibleSessionId: activeSession?.id ?? null,
    tasks,
  });

  // Bootstrap config. RETRY until the gateway answers: under `tauri
  // dev` the webview can load before the sidecar finishes booting, so a one-shot
  // fetch hits ECONNREFUSED and the app would hang on "connecting" forever (the
  // token never arrives, so the WS can't auth). Poll until config lands, then stop.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      fetch(apiBase() + "/api/config")
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((c) => {
          if (cancelled) return;
          setConfig(c); // got the token — stop retrying
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(attempt, 1000); // gateway not up yet
        });
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Native macOS menu bar (Tauri only) — File/Edit/View/Help. The View controls
  // (Theme radio submenu, HUD toggle) live here now that the top toolbar is
  // gone; File items dispatch window events TerminalPane handles. Rebuilt on
  // theme/HUD change so the Theme checkmark + HUD label stay accurate. No-op in
  // the browser dev/web view.
  useEffect(() => {
    installAppMenu({
      themes,
      activeThemeId: activeId,
      hudOpen,
      onSelectTheme: setActiveTheme,
      onToggleHud: () => setHudOpen((v) => !v),
      onNewTerminal: () =>
        window.dispatchEvent(new CustomEvent("conan:new-terminal")),
      onCloseTerminal: () =>
        window.dispatchEvent(new CustomEvent("conan:close-terminal")),
      onToggleTimeline: () =>
        window.dispatchEvent(new CustomEvent("conan:toggle-timeline")),
    }).catch(() => {});
  }, [themes, activeId, hudOpen, setActiveTheme]);

  // US-008: the Conan ▸ Settings menu item (⌘,) dispatches `conan:open-settings`
  // (same window-event bridge the File items use). Listening here keeps the menu
  // decoupled from React state and lets the browser dev build open it too.
  // US-102: the event may carry a `{ tab }` detail so the Timeline's Upgrade
  // button opens directly on the License tab.
  useEffect(() => {
    const open = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      const tab = detail?.tab;
      if (
        tab === "status" ||
        tab === "config" ||
        tab === "appearance" ||
        tab === "license"
      ) {
        setSettingsInitialTab(tab);
      } else {
        setSettingsInitialTab(undefined);
      }
      setSettingsOpen(true);
    };
    window.addEventListener("conan:open-settings", open);
    return () => window.removeEventListener("conan:open-settings", open);
  }, []);

  return (
    // Terminal-primary shell (US-003): no top toolbar — the Claude Code terminal
    // fills the main area and the DevTools-style HUD docks to its right
    // (drag-resizable, width persisted). View/theme/HUD controls live in the
    // native macOS menu bar (installAppMenu above). The TerminalPane's bottom
    // status bar shows cwd + branch (the gateway chip was dropped, US-004). The
    // HUD stays mounted
    // when hidden so its tab state
    // survives the toggle; terminals always stay mounted so ptys survive.
    // US-011: the Claude Radio toolbar lives at the bottom of the HUD panel
    // (inside Hud.tsx), not the app shell.
    // US-025: flex-row when wide (HUD right dock), flex-col when narrow (HUD
    // bottom dock) so the terminal keeps the full width and the HUD stacks below.
    // <UpdateBanner /> is a fixed bottom-left toast — it floats over the
    // shell and renders null when there's no pending update, so it's free
    // to live as a sibling of the layout without reflowing anything.
    <div
      className={
        "flex h-full bg-background text-foreground " +
        (hudBottomDock ? "flex-col" : "flex-row")
      }
    >
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <TerminalPane
        token={config?.token ?? null}
        theme={theme}
        cwd={activeSession?.cwd ?? config?.cwd ?? null}
        git={widgetData?.git ?? null}
        onActiveTidChange={setActiveTid}
        tasks={tasks}
        lastEvent={lastEvent}
        lastSkillFired={lastSkillFired}
        lastSkillConsidered={lastSkillConsidered}
        lastPlan={lastPlan}
        activeSession={activeSession}
        sessions={sessions}
        widgetData={widgetData}
        onRefetchWidgets={refetchWidgets}
        windowWidth={windowWidth}
        doctor={doctor}
      />
      <Hud
        hidden={!hudOpen}
        dock={hudBottomDock ? "bottom" : "right"}
        windowHeight={windowHeight}
        activeSession={activeSession}
        data={widgetData}
        token={config?.token ?? null}
        usage={usage}
        onRefetchUsage={refetchUsage}
        pulse={pulse}
        pulseMinutes={pulseMinutes}
        onPulseRange={setPulseMinutes}
        skills={skills}
        radio={radio}
      />
      <SettingsView
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={claudeConfig}
        token={config?.token ?? null}
        onSaved={refetchConfig}
        themes={themes}
        activeThemeId={activeId}
        onSelectTheme={setActiveTheme}
        doctor={doctor}
        initialTab={settingsInitialTab}
      />
      <UpdateBanner />
      <Onboarding doctor={doctor} />
    </div>
  );
}
