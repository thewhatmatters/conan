//! Native browser view for the Browser surface (WHA-38 spike).
//!
//! The surface has been an `<iframe>`, which costs us four things at once:
//! most sites refuse to be framed at all (`frame-ancestors`), we cannot read
//! the current URL, in-page SPA navigation is invisible, and there is no way
//! to read a selection or capture a screenshot. All four are the same cause —
//! a cross-origin frame is opaque to its embedder.
//!
//! A child webview is a TOP-LEVEL document, so none of that applies: framing
//! headers are irrelevant, and its URL is ours to read whenever we like.
//!
//! The trade, and the thing this spike exists to measure: unlike Electron's
//! `<webview>` (a real DOM element that lays out with CSS), a Tauri child
//! webview is an OS-level view positioned in **window coordinates**. It does
//! not know about `display: none`, `overflow: clip`, border radius, or z-index.
//! The renderer therefore has to drive its geometry and visibility explicitly —
//! everything below exists to make that possible.

use serde::Serialize;
use tauri::{
  LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl, Window,
};

/// Whether the view was last COMMANDED visible. Tauri's `Webview` exposes no
/// `is_visible()`, so this is Conan's own record rather than the OS's — honest
/// as "what we asked for", which is exactly what needs verifying when the
/// question is whether the hide-on-overlay wiring fired.
static COMMANDED_VISIBLE: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

fn set_commanded(visible: bool) {
  if let Ok(mut guard) = COMMANDED_VISIBLE.lock() {
    *guard = visible;
  }
}

fn commanded() -> bool {
  COMMANDED_VISIBLE.lock().map(|g| *g).unwrap_or(false)
}

/// The label of the single browser child webview. One per window is enough for
/// the spike; tabs would key this.
const BROWSER_LABEL: &str = "conan-browser";

/// What the renderer needs back after any command that can change navigation.
#[derive(Serialize, Clone)]
pub struct BrowserState {
  /// The webview's real current URL — including after in-page SPA routing,
  /// which is exactly what an iframe could never tell us.
  pub url: Option<String>,
  /// Whether the view currently exists.
  pub open: bool,
  /// Whether it is actually ON SCREEN. Distinct from `open`, and the difference
  /// matters: the view is hidden (not closed) whenever an overlay would cover
  /// it, so "open" alone cannot tell you whether the user can see the page.
  pub visible: bool,
}

fn parse_url(raw: &str) -> Result<url::Url, String> {
  let parsed = url::Url::parse(raw).map_err(|e| format!("invalid url: {e}"))?;
  match parsed.scheme() {
    "http" | "https" => Ok(parsed),
    other => Err(format!("unsupported scheme: {other}")),
  }
}

/// Create the browser view, or navigate the existing one. Position and size are
/// the pane's rect in window coordinates, measured by the renderer.
#[tauri::command]
pub async fn browser_open<R: Runtime>(
  window: Window<R>,
  url: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> Result<BrowserState, String> {
  let target = parse_url(&url)?;

  if let Some(existing) = window.get_webview(BROWSER_LABEL) {
    existing
      .navigate(target.clone())
      .map_err(|e| format!("navigate failed: {e}"))?;
    // Re-assert geometry: the pane may have moved while the view was hidden.
    let _ = existing.set_position(LogicalPosition::new(x, y));
    let _ = existing.set_size(LogicalSize::new(width, height));
    return Ok(BrowserState {
      url: Some(target.to_string()),
      open: true,
      visible: commanded(),
    });
  }

  let builder = tauri::webview::WebviewBuilder::new(
    BROWSER_LABEL,
    WebviewUrl::External(target.clone()),
  )
  // The surface is a browser, so it must not inherit Conan's own IPC surface.
  .incognito(false);

  window
    .add_child(
      builder,
      LogicalPosition::new(x, y),
      LogicalSize::new(width, height),
    )
    .map_err(|e| format!("could not create the browser view: {e}"))?;

  set_commanded(true);
  Ok(BrowserState { url: Some(target.to_string()), open: true, visible: true })
}

/// Keep the native view glued to the pane. Called on every layout change the
/// renderer observes — resize, splitter drag, dock/undock, window resize.
#[tauri::command]
pub async fn browser_set_bounds<R: Runtime>(
  window: Window<R>,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
) -> Result<(), String> {
  let Some(view) = window.get_webview(BROWSER_LABEL) else {
    return Ok(());
  };
  view
    .set_position(LogicalPosition::new(x, y))
    .map_err(|e| format!("set_position failed: {e}"))?;
  view
    .set_size(LogicalSize::new(width, height))
    .map_err(|e| format!("set_size failed: {e}"))?;
  Ok(())
}

/// Show/hide explicitly. `display: none` on the pane means nothing to an OS
/// view, so the renderer has to say so — this is THE correctness requirement
/// of the whole approach, and the easiest thing to get wrong.
#[tauri::command]
pub async fn browser_set_visible<R: Runtime>(
  window: Window<R>,
  visible: bool,
) -> Result<(), String> {
  let Some(view) = window.get_webview(BROWSER_LABEL) else {
    return Ok(());
  };
  set_commanded(visible);
  if visible {
    view.show().map_err(|e| format!("show failed: {e}"))
  } else {
    view.hide().map_err(|e| format!("hide failed: {e}"))
  }
}

/// The view's CURRENT url — the thing the iframe could never give us, and the
/// whole reason `read_browser` can stop refusing.
#[tauri::command]
pub async fn browser_state<R: Runtime>(window: Window<R>) -> Result<BrowserState, String> {
  match window.get_webview(BROWSER_LABEL) {
    Some(view) => {
      let url = view.url().ok().map(|u| u.to_string());
      Ok(BrowserState { url, open: true, visible: commanded() })
    }
    None => Ok(BrowserState { url: None, open: false, visible: false }),
  }
}

/// Run JS in the browser view — how selection and page text become readable.
/// Returns nothing today: `eval` is fire-and-forget in Tauri, so a real
/// implementation needs the injected script to post its result back. Kept in
/// the spike to prove the call path exists.
#[tauri::command]
pub async fn browser_eval<R: Runtime>(window: Window<R>, script: String) -> Result<(), String> {
  let Some(view) = window.get_webview(BROWSER_LABEL) else {
    return Err("no browser view is open".into());
  };
  view.eval(&script).map_err(|e| format!("eval failed: {e}"))
}

/// Window geometry as Tauri sees it, so a mis-positioned view can be diagnosed
/// with numbers instead of guesses. `add_child` takes LOGICAL coordinates
/// relative to the window; `getBoundingClientRect()` is CSS pixels relative to
/// the webview viewport. Those agree only if the main webview fills the
/// window's content area at scale 1 — this reports whether it actually does.
#[derive(Serialize, Clone)]
pub struct WindowMetrics {
  pub scale_factor: f64,
  pub inner_width: f64,
  pub inner_height: f64,
  pub outer_width: f64,
  pub outer_height: f64,
  /// Window position of the content area, physical.
  pub inner_x: i32,
  pub inner_y: i32,
  pub outer_x: i32,
  pub outer_y: i32,
}

#[tauri::command]
pub async fn browser_window_metrics<R: Runtime>(window: Window<R>) -> Result<WindowMetrics, String> {
  let scale = window.scale_factor().map_err(|e| e.to_string())?;
  let inner = window.inner_size().map_err(|e| e.to_string())?;
  let outer = window.outer_size().map_err(|e| e.to_string())?;
  let inner_pos = window.inner_position().map_err(|e| e.to_string())?;
  let outer_pos = window.outer_position().map_err(|e| e.to_string())?;
  Ok(WindowMetrics {
    scale_factor: scale,
    inner_width: inner.width as f64,
    inner_height: inner.height as f64,
    outer_width: outer.width as f64,
    outer_height: outer.height as f64,
    inner_x: inner_pos.x,
    inner_y: inner_pos.y,
    outer_x: outer_pos.x,
    outer_y: outer_pos.y,
  })
}

#[tauri::command]
pub async fn browser_close<R: Runtime>(window: Window<R>) -> Result<(), String> {
  if let Some(view) = window.get_webview(BROWSER_LABEL) {
    view.close().map_err(|e| format!("close failed: {e}"))?;
  }
  set_commanded(false);
  Ok(())
}
