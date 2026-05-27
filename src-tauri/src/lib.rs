use std::sync::Mutex;

use tauri::{Manager, RunEvent};
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
    .manage(GatewayChild(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Spawn the bundled gateway sidecar. CONAN_PORT pins the loopback port the
      // webview's hard-coded base (ui/src/lib/gateway.ts) expects;
      // CONAN_ALLOWED_ORIGINS lets the WS upgrade accept the Tauri origin.
      let sidecar = app
        .shell()
        .sidecar("conan-gateway")?
        .env("CONAN_PORT", "3747")
        .env("CONAN_ALLOWED_ORIGINS", ALLOWED_ORIGINS);
      // In dev, Tauri copies only the triple-stripped binary to target/debug/,
      // leaving its runtime/ tree behind in src-tauri/binaries/. Point the
      // launcher at the real runtime dir so it can exec node + gateway.cjs.
      // (In a release .app the launcher finds runtime/ via ../Resources — US-010.)
      #[cfg(debug_assertions)]
      let sidecar = sidecar.env(
        "CONAN_GATEWAY_DIR",
        concat!(env!("CARGO_MANIFEST_DIR"), "/binaries/runtime"),
      );
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
