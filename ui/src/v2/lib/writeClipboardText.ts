/** Write to the clipboard without surfacing permission failures to the app. */
export async function writeClipboardText(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard access is best-effort, matching v1's interaction contract.
  }
}
