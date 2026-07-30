/**
 * PinsDrawer + useComposerAttachments (p2c US-301).
 *
 * The chips are Astryx `Token`s inside `ChatComposerDrawer`; the ✕ is Token's
 * own remove button ("Remove <label>").
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import PinsDrawer from "../chat/composer/PinsDrawer.tsx";
import {
  fmtBytes,
  pinName,
  useComposerAttachments,
  type V2Pin,
} from "../lib/useComposerAttachments.ts";

function pin(path: string, extra: Partial<V2Pin> = {}): V2Pin {
  return {
    path,
    content: "body",
    bytes: 4,
    totalBytes: 4,
    truncated: false,
    ...extra,
  };
}

describe("PinsDrawer", () => {
  it("renders nothing when nothing is staged", () => {
    const { container } = render(
      <PinsDrawer pins={[]} onRemovePin={vi.fn()} />,
    );
    expect(container.querySelector('[data-slot="pins-drawer"]')).toBeNull();
  });

  it("renders one chip per pin, labelled with the file name", () => {
    render(
      <PinsDrawer
        pins={[pin("/repo/project_brief.pdf"), pin("/repo/src/api_spec.yaml")]}
        onRemovePin={vi.fn()}
      />,
    );

    expect(screen.getByText("project_brief.pdf")).toBeInTheDocument();
    expect(screen.getByText("api_spec.yaml")).toBeInTheDocument();
  });

  it("removes a pin through the chip's ✕", () => {
    const onRemovePin = vi.fn();
    render(
      <PinsDrawer pins={[pin("/repo/notes.md")]} onRemovePin={onRemovePin} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(onRemovePin).toHaveBeenCalledWith("/repo/notes.md");
  });

  it("counts images alongside pins and removes them by index", () => {
    const onRemoveImage = vi.fn();
    render(
      <PinsDrawer
        pins={[pin("/repo/a.ts")]}
        images={[{ mediaType: "image/png", data: "AAA" }]}
        onRemovePin={vi.fn()}
        onRemoveImage={onRemoveImage}
      />,
    );

    // Collapsed badge shows the total (pins + images).
    expect(screen.getByText("2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Image 1" }));
    expect(onRemoveImage).toHaveBeenCalledWith(0);
  });
});

describe("useComposerAttachments", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ content: "file body", totalBytes: 20, readBytes: 9 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stages a path through /api/fs/read and serializes CONTENT, not the path", async () => {
    const { result } = renderHook(() => useComposerAttachments("tok"));

    await act(async () => {
      await result.current.pinPath("/repo/README.md");
    });

    await waitFor(() => expect(result.current.pins).toHaveLength(1));
    expect(result.current.pins[0]).toMatchObject({
      path: "/repo/README.md",
      content: "file body",
      bytes: 9,
      totalBytes: 20,
      truncated: true,
    });
    expect(result.current.toOutgoing().attachments).toEqual([
      {
        type: "file",
        path: "/repo/README.md",
        content: "file body",
        truncated: true,
      },
    ]);
  });

  it("never stages the same path twice", async () => {
    const { result } = renderHook(() => useComposerAttachments("tok"));

    await act(async () => {
      await result.current.pinPath("/repo/README.md");
    });
    await act(async () => {
      await result.current.pinPath("/repo/README.md");
    });

    expect(result.current.pins).toHaveLength(1);
  });

  it("drops a removed pin from the outgoing turn", async () => {
    const { result } = renderHook(() => useComposerAttachments("tok"));

    await act(async () => {
      await result.current.pinPath("/repo/README.md");
    });
    act(() => result.current.removePin("/repo/README.md"));

    expect(result.current.pins).toHaveLength(0);
    expect(result.current.toOutgoing().attachments).toEqual([]);
  });

  it("clears one-shot staging after a send but keeps `keep` pins", async () => {
    const { result } = renderHook(() => useComposerAttachments("tok"));

    await act(async () => {
      await result.current.pinPath("/repo/README.md");
      result.current.addImage({ mediaType: "image/png", data: "AAA" });
    });
    act(() => result.current.clearAfterSend());

    expect(result.current.pins).toHaveLength(0);
    expect(result.current.images).toHaveLength(0);
  });

  it("caps staged images at four", () => {
    const { result } = renderHook(() => useComposerAttachments("tok"));

    act(() => {
      for (let i = 0; i < 6; i++)
        result.current.addImage({ mediaType: "image/png", data: `${i}` });
    });

    expect(result.current.images).toHaveLength(4);
  });

  it("does not call the gateway without a token", async () => {
    const { result } = renderHook(() => useComposerAttachments(null));

    await act(async () => {
      await result.current.pinPath("/repo/README.md");
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.pins).toHaveLength(0);
  });
});

describe("pin helpers", () => {
  it("pinName takes the last path segment", () => {
    expect(pinName("/a/b/c.ts")).toBe("c.ts");
    expect(pinName("bare.txt")).toBe("bare.txt");
  });

  it("fmtBytes scales B/KB/MB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
