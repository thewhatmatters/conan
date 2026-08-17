/**
 * Open a folder path in the native file manager.
 *
 * In the Tauri app this routes through `@tauri-apps/plugin-shell`; in a
 * browser dev context it falls back to a `file://` tab (which most browsers
 * block, but it is the only portable fallback).
 */
export async function openFolder(path: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(path);
  } catch {
    window.open(`file://${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer");
  }
}
