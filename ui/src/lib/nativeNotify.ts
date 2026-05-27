import { isTauri } from "./gateway.ts";

/**
 * Native OS notifications (US-011) — Tauri only.
 *
 * Surfaces Claude Code's `Notification` hook prompts (permission requests /
 * waiting-for-input) as macOS banners so a user working in another app is
 * pulled back to acknowledge them. Everything here is guarded by `isTauri()`;
 * in the plain browser dev view these are no-ops and the in-app Toaster is the
 * fallback surface instead (see Toaster.tsx).
 *
 * The plugin module is imported dynamically so the web build never pulls the
 * Tauri API into a context where `__TAURI_INTERNALS__` is absent.
 */

// Cache the permission grant across calls so we only prompt once per launch.
let permission: "granted" | "denied" | "unknown" = "unknown";

/**
 * Ensure notification permission, requesting it on first use. Returns true only
 * when granted; denial is cached and respected gracefully (no repeat prompts).
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  if (permission === "granted") return true;
  if (permission === "denied") return false;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    permission = granted ? "granted" : "denied";
    return granted;
  } catch {
    permission = "denied";
    return false;
  }
}

/** Fire a native notification (no-op outside Tauri / when permission is absent). */
export async function sendNativeNotification(
  title: string,
  body: string,
): Promise<void> {
  if (!isTauri()) return;
  if (!(await ensureNotificationPermission())) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title, body });
  } catch {
    /* plugin unavailable — drop silently */
  }
}

/**
 * Register a single click handler that brings Conan to the foreground when a
 * notification is tapped, then runs `onFocus` so the caller can select the
 * correlated terminal tab. Returns a cleanup fn. No-op outside Tauri.
 */
export async function onNotificationClick(
  onFocus: () => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const { onAction } = await import("@tauri-apps/plugin-notification");
    const listener = await onAction(async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        await w.unminimize().catch(() => {});
        await w.show().catch(() => {});
        await w.setFocus().catch(() => {});
      } catch {
        /* window API unavailable */
      }
      onFocus();
    });
    return () => listener.unregister();
  } catch {
    return () => {};
  }
}
