use std::sync::Mutex;

use tauri::{Manager, RunEvent};

mod browser;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the spawned gateway sidecar child so we can kill it on app exit.
/// The gateway is single-instance on :3747 and refuses to start if the port is
/// bound, so a leaked sidecar would block the next launch (research §2).
struct GatewayChild(Mutex<Option<CommandChild>>);

/// Origins the bundled webview connects from — production macOS is
/// `tauri://localhost`; Windows/Android use `https://tauri.localhost`; the dev
/// server (`tauri dev`) is `http://localhost:5173`. The gateway's Origin
/// allowlist (CVE-2025-52882 floor) must accept these or the WS upgrade fails.
const ALLOWED_ORIGINS: &str =
  "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:5173";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    // US-011: native OS notifications surfacing Claude's `Notification` hook
    // prompts (permission requests / waiting-for-input) so the user is pulled
    // back to acknowledge them. The UI fires these over the app WS via
    // @tauri-apps/plugin-notification; permission is requested on first use.
    .plugin(tauri_plugin_notification::init())
    // US-011 (chat v1): native folder-picker for the per-thread working
    // directory chip; the browser/dev context falls back to /api/fs/list.
    .plugin(tauri_plugin_dialog::init())
    // Self-update: the JS-side @tauri-apps/plugin-updater check()s the
    // manifest URL in tauri.conf.json `plugins.updater.endpoints` against
    // the bundled minisign pubkey, downloads the signed .app.tar.gz when
    // a newer version exists, and the UI's <UpdateBanner> calls
    // plugin-process.relaunch() to apply it.
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(GatewayChild(Mutex::new(None)))
    // WHA-38: the Browser surface's native view. An OS-level child webview
    // rather than an iframe, so framing headers don't apply and its URL is
    // readable — at the cost of the renderer having to drive its geometry.
    .invoke_handler(tauri::generate_handler![
      browser::browser_open,
      browser::browser_set_bounds,
      browser::browser_set_visible,
      browser::browser_state,
      browser::browser_eval,
      browser::browser_close,
      browser::browser_window_metrics,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Pin the gateway's data dir to a stable, writable, per-user location.
      // Without this, paths.ts derives DATA_DIR from the bundled gateway.cjs
      // location — landing it inside the read-only .app bundle (wiped on every
      // update) in release, and inside src-tauri/binaries in dev (split-brain
      // with the repo-root .data). app_data_dir is the desktop-correct home
      // (~/Library/Application Support/<bundle-id>) and survives updates.
      let data_dir = app.path().app_data_dir()?;
      std::fs::create_dir_all(&data_dir)?;

      // Spawn the bundled gateway sidecar. CONAN_PORT pins the loopback port the
      // webview's hard-coded base (ui/src/lib/gateway.ts) expects;
      // CONAN_ALLOWED_ORIGINS lets the WS upgrade accept the Tauri origin.
      let sidecar = app
        .shell()
        .sidecar("conan-gateway")?
        .env("CONAN_PORT", "3747")
        .env("CONAN_ALLOWED_ORIGINS", ALLOWED_ORIGINS)
        .env("CONAN_DATA_DIR", data_dir.to_string_lossy().to_string())
        // Arms the gateway's stdin-EOF watchdog: if this app dies/quits without
        // the ExitRequested kill landing (seen on macOS Apple-event quit), the
        // closed stdin pipe lets the sidecar self-terminate and free :3747.
        .env("CONAN_SIDECAR", "1");
      // In dev, Tauri copies only the triple-stripped binary to target/debug/,
      // leaving its runtime/ tree behind in src-tauri/binaries/. Point the
      // launcher at the real runtime dir so it can exec node + gateway.cjs.
      // (In a release .app the launcher finds runtime/ via ../Resources — US-010.)
      #[cfg(debug_assertions)]
      let sidecar = sidecar.env(
        "CONAN_GATEWAY_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/binaries/runtime"),
      );

      // CONAN_PLUGIN_DIR: where the bundled `plugin/<name>/skills/...` tree
      // lives on disk. The gateway symlinks each <name> subdir into
      // ~/.claude/plugins/<name>/ on boot so Claude Code discovers the skills
      // as plugin-sourced (and atomic app-updates carry the latest version).
      // Debug: the repo-root plugin/ next to src-tauri/. Release: the bundled
      // resource dir (Contents/Resources/plugin/ on macOS).
      #[cfg(debug_assertions)]
      let sidecar = sidecar.env(
        "CONAN_PLUGIN_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/../plugin"),
      );
      #[cfg(not(debug_assertions))]
      let sidecar = {
        let resource_plugin_dir = app
          .path()
          .resolve("plugin", tauri::path::BaseDirectory::Resource)
          .map(|p| p.to_string_lossy().to_string())
          .unwrap_or_default();
        sidecar.env("CONAN_PLUGIN_DIR", resource_plugin_dir)
      };
      let (mut rx, child) = sidecar.spawn()?;
      app
        .state::<GatewayChild>()
        .0
        .lock()
        .unwrap()
        .replace(child);

      // Pipe the sidecar's stdout/stderr into the Tauri log for debugging.
      tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(bytes) => {
              log::info!("[gateway] {}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Stderr(bytes) => {
              log::warn!("[gateway] {}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Error(err) => log::error!("[gateway] {err}"),
            CommandEvent::Terminated(payload) => {
              log::info!("[gateway] terminated: {payload:?}");
            }
            _ => {}
          }
        }
      });

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Kill the sidecar when the app quits so :3747 is free for next launch.
      if let RunEvent::ExitRequested { .. } = event {
        if let Some(child) = app_handle
          .state::<GatewayChild>()
          .0
          .lock()
          .unwrap()
          .take()
        {
          let _ = child.kill();
        }
      }
    });
}
