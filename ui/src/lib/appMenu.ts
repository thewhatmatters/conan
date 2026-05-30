import { isTauri } from "./gateway.ts";
import { AUTO_ID } from "../hooks/useThemes.ts";
import type { Theme } from "./themes.ts";
// Source of truth for the app version — the single place version flows from.
// Bumping in package.json automatically flows into the About box, About
// dialog copyright, and any other surface that imports CONAN_VERSION. Vite
// resolves the JSON import statically (no runtime fetch).
import pkg from "../../../package.json" with { type: "json" };

export interface AppMenuActions {
  /** All selectable themes (built-ins + user themes) for the Theme submenu. */
  themes: Theme[];
  /** The active selection id (a theme id, or "auto") — drives the radio check. */
  activeThemeId: string;
  hudOpen: boolean;
  /** Select a theme by id (or "auto"); stays in sync with the Appearance picker. */
  onSelectTheme: (id: string) => void;
  onToggleHud: () => void;
  onNewTerminal: () => void;
  onCloseTerminal: () => void;
  /** US-005: View ▸ Split Timeline (⌘\) — toggles the active tab's
   *  per-terminal Timeline split panel. */
  onToggleTimeline: () => void;
}

/** Conan's own version, shown in the About box. Sourced from package.json so
 *  it always matches what `npm run release` ships — never hand-edit. */
export const CONAN_VERSION = pkg.version;
/** AboutMetadata payload for the macOS About dialog (Conan ▸ About Conan).
 *  Tauri's PredefinedMenuItem.About accepts the full Apple-style AboutDialog
 *  shape — name, version, copyright, website, authors, credits, license.
 *  Add fields here to surface them; macOS renders them inline below the
 *  app icon. */
const ABOUT = {
  name: "Conan",
  version: CONAN_VERSION,
  copyright: "Copyright © 2026 WhatMatters LLC. All rights reserved.",
};

/**
 * Build + install the native macOS menu bar (Conan / File / Edit / View / Help)
 * for the Tauri desktop app. No-op in a plain browser — the web build has no
 * native menu bar, so the menu only exists in the desktop app (this is why the
 * theme + HUD toggles moved here from the old in-window toolbar).
 *
 * Rebuilt whenever theme / HUD state changes so the View ▸ Theme radio
 * checkmark follows the active choice and the HUD label stays accurate
 * ("Hide HUD"⇄"Show HUD"). Menu actions run here in
 * the webview and call straight into React state; the File items dispatch window
 * CustomEvents that TerminalPane listens for (its tab state lives locally).
 *
 * Uses `core:menu` (already bundled in `core:default`), so no capability change
 * or Rust recompile is needed — it lands through `tauri dev` HMR. The Edit menu
 * carries the predefined clipboard items so ⌘C/⌘V/⌘A keep working in the
 * terminal + HUD once we replace Tauri's default app menu.
 */
export async function installAppMenu(a: AppMenuActions): Promise<void> {
  if (!isTauri()) return;
  const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } =
    await import("@tauri-apps/api/menu");

  const about = () => PredefinedMenuItem.new({ item: { About: ABOUT } });
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });

  const appMenu = await Submenu.new({
    text: "Conan",
    items: [
      await about(),
      await sep(),
      // US-008: open the read-only Settings view. Dispatches a window event App
      // listens for (same bridge as the File items) rather than calling React
      // state directly, so the menu stays decoupled and the browser build works.
      await MenuItem.new({
        text: "Settings…",
        accelerator: "CmdOrCtrl+,",
        action: () =>
          window.dispatchEvent(new CustomEvent("conan:open-settings")),
      }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({
        text: "New Terminal",
        accelerator: "CmdOrCtrl+T",
        action: () => a.onNewTerminal(),
      }),
      await MenuItem.new({
        text: "Close Terminal",
        accelerator: "CmdOrCtrl+W",
        action: () => a.onCloseTerminal(),
      }),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  // View ▸ Theme radio submenu (US-011; full theme list in US-023). CheckMenuItem
  // carries the checkmark; selecting one calls onSelectTheme, which flips React
  // state and re-runs installAppMenu, rebuilding the menu so the check follows
  // the active choice — staying in sync with the Appearance-tab picker (both
  // drive the same useThemes store). (Tauri has no native radio group, so we
  // model it as checks + a rebuild.) The list mirrors the picker: Auto first,
  // then themes grouped Light / Dark.
  const themeItem = (text: string, id: string) =>
    CheckMenuItem.new({
      text,
      checked: a.activeThemeId === id,
      action: () => a.onSelectTheme(id),
    });
  const lightThemes = a.themes.filter((t) => t.type === "light");
  const darkThemes = a.themes.filter((t) => t.type === "dark");
  const themeMenu = await Submenu.new({
    text: "Theme",
    items: [
      await themeItem("Auto — match system", AUTO_ID),
      await sep(),
      ...(await Promise.all(lightThemes.map((t) => themeItem(t.name, t.id)))),
      ...(darkThemes.length ? [await sep()] : []),
      ...(await Promise.all(darkThemes.map((t) => themeItem(t.name, t.id)))),
    ],
  });

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      themeMenu,
      await sep(),
      await MenuItem.new({
        text: a.hudOpen ? "Hide HUD" : "Show HUD",
        accelerator: "CmdOrCtrl+Shift+H",
        action: () => a.onToggleHud(),
      }),
      // US-005: parity with File ▸ New/Close Terminal — dispatches a window
      // event TerminalPane listens for so the menu stays decoupled from React
      // state. The ⌘\ accelerator is mirrored by a webview-level keydown in
      // TerminalPane for the browser dev build (which has no native menu).
      await MenuItem.new({
        text: "Split Timeline",
        accelerator: "CmdOrCtrl+\\",
        action: () => a.onToggleTimeline(),
      }),
      await sep(),
      // Tauri doesn't wire Cmd+R to reload by default — without this, the
      // user has no way to refresh the UI after a code change short of
      // quitting the app. `window.location.reload()` runs in the webview and
      // re-fetches the bundled (or dev-server) UI; the gateway sidecar is
      // unaffected so ptys/sessions survive the reload (footgun #2 still
      // applies — pty WS closes on reload until US-017/018 lands).
      await MenuItem.new({
        text: "Reload",
        accelerator: "CmdOrCtrl+R",
        action: () => window.location.reload(),
      }),
    ],
  });

  const helpMenu = await Submenu.new({
    text: "Help",
    items: [await about()],
  });

  const menu = await Menu.new({
    items: [appMenu, fileMenu, editMenu, viewMenu, helpMenu],
  });
  await menu.setAsAppMenu();
}
