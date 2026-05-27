import { isTauri } from "./gateway.ts";

export interface AppMenuActions {
  theme: "light" | "dark";
  hudOpen: boolean;
  onToggleTheme: () => void;
  onToggleHud: () => void;
  onNewTerminal: () => void;
  onCloseTerminal: () => void;
}

const ABOUT = { name: "Conan", version: "0.1.0" };

/**
 * Build + install the native macOS menu bar (Conan / File / Edit / View / Help)
 * for the Tauri desktop app. No-op in a plain browser — the web build has no
 * native menu bar, so the menu only exists in the desktop app (this is why the
 * theme + HUD toggles moved here from the old in-window toolbar).
 *
 * Rebuilt whenever theme / HUD state changes so the toggle labels stay accurate
 * ("Dark Mode"⇄"Light Mode", "Hide HUD"⇄"Show HUD"). Menu actions run here in
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
  const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import(
    "@tauri-apps/api/menu"
  );

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

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      await MenuItem.new({
        text: a.theme === "dark" ? "Light Mode" : "Dark Mode",
        action: () => a.onToggleTheme(),
      }),
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
