import { Suspense, useEffect, useState } from "react";
import { AppV2, isV2Enabled } from "./v2/entry.tsx";
import { useThemes } from "./hooks/useThemes.ts";
import { useGateway } from "./hooks/useTasks.ts";
import { useSessions } from "./hooks/useSessions.ts";
import ChatSurface from "./components/ChatSurface.tsx";
import InstallBanner from "./components/InstallBanner.tsx";
import { useConfig } from "./hooks/useConfig.ts";
import { useDoctor } from "./hooks/useDoctor.ts";
import { useGlobalHooks } from "./hooks/useGlobalHooks.ts";
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
 * v2 flag (T0 · docs/v2-astryx-redesign.md §4.1). Read ONCE at module scope,
 * not per render: v1 and v2 load different global stylesheets, so flipping
 * `localStorage.conan-v2` takes effect on the next reload rather than
 * mid-session. With the flag off nothing below `v2/entry.tsx` is fetched —
 * the Astryx CSS and bundle live in their own dynamic chunk — so v1 is
 * unchanged, which is the whole point while we dogfood v1 to build v2.
 */
const V2 = isV2Enabled();

export default function App() {
  // Deliberately before any hook: with the flag on, AppV1 never mounts, so
  // none of its hooks (gateway WS, config poll, native menu) ever run. The
  // early return is safe because `V2` is a module constant — it cannot change
  // between renders, so the hook order below is stable.
  if (V2) {
    return (
      <Suspense fallback={null}>
        <AppV2 />
      </Suspense>
    );
  }
  return <AppV1 />;
}

/**
 * Chat-primary shell (US-012): the thread sidebar + chat surface IS Conan's
 * main surface. The terminal-era shell (TerminalPane, the Terminal|Chat
 * SurfaceSwitch, the HUD dock and its widget hooks) was removed from the
 * mount — the pty/gateway terminal code stays in the repo but dormant.
 * Session-scoped concerns now bind to the ACTIVE chat thread's session id
 * (reported up by ChatSurface) instead of pty correlation.
 *
 * This is v1, and it stays the default: T0 only moved it behind the flag
 * router above. Its body is unchanged.
 */
function AppV1() {
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
  // The built-in theme set (Light/Dark) + the active selection ("light" /
  // "dark" / "auto"), shared through useThemes's apply store so the Appearance
  // picker and the View ▸ Theme menu reskin live and persist across reload.
  const { themes, activeId, setActiveTheme } = useThemes();
  const { tasks, lastEvent, lastSkillFired, reconnectSeq } = useGateway(
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
  // US-023: global-hook install status + one-click installer for the
  // onboarding hard-gate — the spine/skills need hooks, no terminal fallback.
  const globalHooks = useGlobalHooks(config?.token ?? null);
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

  // US-003: direct ⌘, / Ctrl+, handler so Settings is reachable without the
  // Tauri native menu (browser dev builds have no menu bar). The modifier
  // requirement means a bare "," typed in the composer/inputs never triggers
  // it. In the packaged app the native menu accelerator may also fire — both
  // paths converge on setSettingsOpen(true), so a double is harmless.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "," && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSettingsInitialTab(undefined);
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
        lastSkillFired={lastSkillFired}
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
      <Onboarding doctor={doctor} hooks={globalHooks} />
      <WhatsNew />
    </div>
  );
}
