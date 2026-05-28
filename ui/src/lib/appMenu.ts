import { isTauri } from "./gateway.ts";
import type { ThemePreference } from "../hooks/useTheme.ts";

export interface AppMenuActions {
  /** The user's stored theme choice (drives the radio checkmark). */
  themePreference: ThemePreference;
  hudOpen: boolean;
  onSetTheme: (p: ThemePreference) => void;
  onToggleHud: () => void;
  onNewTerminal: () => void;
  onCloseTerminal: () => void;
}

/** Conan's own version, shown in the About box. */
export const CONAN_VERSION = "0.1.0";
const ABOUT = { name: "Conan", version: CONAN_VERSION };

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

  // View ▸ Theme radio submenu (US-011). CheckMenuItem carries the checkmark;
  // selecting one calls onSetTheme, which flips React state and re-runs
  // installAppMenu, rebuilding the menu so the check follows the active choice.
  // (Tauri has no native radio group, so we model it as checks + a rebuild.)
  const themeItem = (text: string, value: ThemePreference) =>
    CheckMenuItem.new({
      text,
      checked: a.themePreference === value,
      action: () => a.onSetTheme(value),
    });
  const themeMenu = await Submenu.new({
    text: "Theme",
    items: [
      await themeItem("Light", "light"),
      await themeItem("Dark", "dark"),
      await themeItem("Auto — match system", "auto"),
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
