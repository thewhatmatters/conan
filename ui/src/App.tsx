import { useEffect, useState } from "react";
import { useThemes } from "./hooks/useThemes.ts";
import { useUserThemes } from "./hooks/useUserThemes.ts";
import { useGateway } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import ChatSurface from "./components/ChatSurface.tsx";
import InstallBanner from "./components/InstallBanner.tsx";
import { useConfig } from "./hooks/useConfig.ts";
import { useDoctor } from "./hooks/useDoctor.ts";
import { useTier } from "./hooks/useTier.ts";
import Toaster from "./components/Toaster.tsx";
import SettingsView from "./components/SettingsView.tsx";
import UpdateBanner from "./components/UpdateBanner.tsx";
import Onboarding from "./components/Onboarding.tsx";
import WhatsNew from "./components/WhatsNew.tsx";
import { apiBase } from "./lib/gateway.ts";
import { installAppMenu } from "./lib/appMenu.ts";
import { useNativeNotifications } from "./hooks/useNativeNotifications.ts";

interface Config {
  token: string;
  port: number;
  cwd: string;
  /** US-007: runtime-configurable Buy Premium checkout URL (CONAN_BUY_URL).
   *  Null when no override is set — the UI then uses its bundled checkout link. */
  buyUrl?: string | null;
}

/**
 * Chat-primary shell (US-012): the thread sidebar + chat surface IS Conan's
 * main surface. The terminal-era shell (TerminalPane, the Terminal|Chat
 * SurfaceSwitch, the HUD dock and its widget hooks) was removed from the
 * mount — the pty/gateway terminal code stays in the repo but dormant.
 * Session-scoped concerns now bind to the ACTIVE chat thread's session id
 * (reported up by ChatSurface) instead of pty correlation.
 */
export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  // US-008: the read-only Settings view, opened from Conan ▸ Settings (⌘,).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // US-102: the Upgrade CTAs dispatch `conan:open-settings` with
  // `{ detail: { tab: "license" } }` so the Free user lands directly on
  // the paste-your-license surface. Plain ⌘, opens with `undefined` and falls
  // through to the dialog's default tab (Status).
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "status" | "config" | "appearance" | "license" | undefined
  >(undefined);
  // US-023: the full theme set (built-ins + user themes from ~/.conan/themes.json)
  // and the active selection. useThemes registers the user themes into the shared
  // apply store, so selecting one — in the Appearance picker or the View ▸ Theme
  // menu — reskins the app live and persists by id across reload.
  const userThemes = useUserThemes(config?.token ?? null);
  const { themes, activeId, setActiveTheme } = useThemes(userThemes);
  const { tasks, lastEvent, reconnectSeq } = useGateway(
    config?.token ?? null,
    [],
  );
  // A trigger that advances on each live event *and* each reconnect, so the
  // REST-backed hooks re-pull their snapshots after a connection gap.
  const wsTrigger = (lastEvent?.seq ?? 0) + reconnectSeq;
  const { sessions } = useSessions(wsTrigger);
  // US-012: the Claude session id of the ACTIVE chat thread, reported up by
  // ChatSurface — the chat-era successor to the pty→session correlation.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // US-008: Claude Code's config mirror for the Settings view; refetch re-reads
  // after the Config tab writes a key (US-010) so the saved value sticks.
  const [claudeConfig, refetchConfig] = useConfig(config?.token ?? null);
  // Probe whether the user has Claude Code installed (src/doctor/claude.ts).
  // Drives the install banner above the chat surface + the Settings ▸ Status
  // line. Backend caches 10min so this is cheap.
  const doctor = useDoctor(config?.token ?? null);
  // US-101: Premium tier hook — boots once when the token arrives, then every
  // gated surface reads `useTier()` to flip Free ↔ Premium. Idempotent.
  useTier(config?.token ?? null);
  // US-011: native macOS notifications for Claude's `Notification` hook prompts.
  // A prompt for the visible (active) thread's session while Conan is focused
  // is suppressed — the user sees it live in the transcript.
  useNativeNotifications({
    lastEvent,
    sessions,
    visibleSessionId: activeSessionId,
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

  // Native macOS menu bar (Tauri only) — File/Edit/View/Help. Rebuilt on theme
  // change so the Theme checkmark stays accurate. File ▸ New/Close Chat
  // dispatch window events ChatSurface handles (its thread state lives
  // locally). No-op in the browser dev/web view.
  useEffect(() => {
    installAppMenu({
      themes,
      activeThemeId: activeId,
      onSelectTheme: setActiveTheme,
      onNewChat: () => window.dispatchEvent(new CustomEvent("conan:new-chat")),
      onCloseChat: () =>
        window.dispatchEvent(new CustomEvent("conan:close-chat")),
    }).catch(() => {});
  }, [themes, activeId, setActiveTheme]);

  // US-008: the Conan ▸ Settings menu item (⌘,) dispatches `conan:open-settings`
  // (same window-event bridge the File items use). Listening here keeps the menu
  // decoupled from React state and lets the browser dev build open it too.
  // US-102: the event may carry a `{ tab }` detail so Upgrade CTAs open
  // directly on the License tab.
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
    // <UpdateBanner /> is a fixed bottom-left toast — it floats over the
    // shell and renders null when there's no pending update, so it's free
    // to live as a sibling of the layout without reflowing anything.
    <div className="flex h-full flex-col bg-background text-foreground">
      <Toaster tasks={tasks} lastEvent={lastEvent} />
      <InstallBanner doctor={doctor} />
      <ChatSurface
        token={config?.token ?? null}
        defaultCwd={config?.cwd ?? null}
        onActiveSessionChange={setActiveSessionId}
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
        buyUrl={config?.buyUrl ?? null}
      />
      <UpdateBanner />
      <Onboarding doctor={doctor} />
      <WhatsNew />
    </div>
  );
}
