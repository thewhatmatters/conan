import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardText } from "../lib/writeClipboardText.ts";

describe("writeClipboardText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("contains clipboard permission failures", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeClipboardText("thread-id")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("thread-id");
  });

  it("waits for the browser clipboard operation to settle", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("navigator", { clipboard: { writeText: () => gate } });

    const operation = writeClipboardText("thread-id");
    const state = await Promise.race([
      operation.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);

    expect(state).toBe("pending");
    release?.();
    await expect(operation).resolves.toBeUndefined();
  });
});
