/**
 * v2 composer attachments adapter (p2c US-301 / US-304).
 *
 * The state behind the composer's drawer: @-pins (file CONTENT that rides the
 * next turn) and pasted images. It mirrors v1's ChatPane behaviour exactly —
 * `/api/fs/read` supplies the content, the gateway does the real bounding at
 * turn time, and `keep` pins survive a send while one-shot pins drop — but it
 * lives in `v2/lib` so no v1 component is imported (contract §4.5).
 *
 * Serialization is v1's: a pin becomes an `OutgoingFileAttachment` carrying
 * `content`, not a path (`src/agent/attachments.ts` inlines it into the
 * prompt). The gateway is untouched.
 */
import { useCallback, useState } from "react";
import { apiBase } from "../../lib/gateway.ts";
import type {
  OutgoingFileAttachment,
  OutgoingImage,
} from "../../hooks/useAgentChat.ts";

/** A staged pin — the file's content plus what the read actually covered. */
export interface V2Pin {
  /** Absolute path (or the dropped file's name, which has no disk path). */
  path: string;
  content: string;
  /** Bytes actually read (the drawer chip's honesty about a capped read). */
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  /** Survives a send (v1's `keep`) — reserved for a future pin-lock affordance. */
  keep?: boolean;
}

/** Ceiling for a client-side (dropped/pasted) file read, matching the spirit of
 *  the gateway's own cap on `/api/fs/read`: a pin is context, not a payload. */
const CLIENT_READ_CAP = 128 * 1024;
/** v1 stages at most four images per turn; the gateway bounds them again. */
const MAX_IMAGES = 4;

export interface ComposerAttachments {
  pins: V2Pin[];
  images: OutgoingImage[];
  /** Stage a file already on disk — reads it through the gateway. */
  pinPath: (path: string) => Promise<void>;
  /** Stage a File from a paste/drop — read in the browser, no disk path. */
  pinFile: (file: File) => Promise<void>;
  addImage: (image: OutgoingImage) => void;
  removePin: (path: string) => void;
  removeImage: (index: number) => void;
  /** Drop the one-shot staging after a send (v1: `keep` pins survive). */
  clearAfterSend: () => void;
  /** The shapes `send()` takes — pins serialize as content, like v1. */
  toOutgoing: () => {
    attachments: OutgoingFileAttachment[];
    images: OutgoingImage[];
  };
}

export function useComposerAttachments(
  token: string | null,
): ComposerAttachments {
  const [pins, setPins] = useState<V2Pin[]>([]);
  const [images, setImages] = useState<OutgoingImage[]>([]);

  const stage = useCallback((pin: V2Pin) => {
    // Same path pinned twice is one chip — re-pinning is a no-op, not a dupe.
    setPins((prev) =>
      prev.some((p) => p.path === pin.path) ? prev : [...prev, pin],
    );
  }, []);

  const pinPath = useCallback(
    async (path: string) => {
      if (!token) return;
      const r = await fetch(
        apiBase() + `/api/fs/read?path=${encodeURIComponent(path)}`,
        { headers: { "x-conan-token": token } },
      );
      if (!r.ok) return;
      const d = (await r.json()) as {
        content: string;
        totalBytes: number;
        readBytes: number;
      };
      stage({
        path,
        content: d.content,
        bytes: d.readBytes,
        totalBytes: d.totalBytes,
        truncated: d.readBytes < d.totalBytes,
      });
    },
    [token, stage],
  );

  const pinFile = useCallback(
    async (file: File) => {
      // A dropped/pasted file never touched disk from the gateway's side, so
      // the browser reads it and the chip shows the file's own name as path.
      const text = await file.slice(0, CLIENT_READ_CAP).text();
      stage({
        path: file.name,
        content: text,
        bytes: Math.min(file.size, CLIENT_READ_CAP),
        totalBytes: file.size,
        truncated: file.size > CLIENT_READ_CAP,
      });
    },
    [stage],
  );

  const addImage = useCallback((image: OutgoingImage) => {
    setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, image]));
  }, []);

  const removePin = useCallback((path: string) => {
    setPins((prev) => prev.filter((p) => p.path !== path));
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAfterSend = useCallback(() => {
    setPins((prev) => prev.filter((p) => p.keep));
    setImages([]);
  }, []);

  const toOutgoing = useCallback(
    () => ({
      attachments: pins.map((p) => ({
        type: "file" as const,
        path: p.path,
        content: p.content,
        truncated: p.truncated,
      })),
      images,
    }),
    [pins, images],
  );

  return {
    pins,
    images,
    pinPath,
    pinFile,
    addImage,
    removePin,
    removeImage,
    clearAfterSend,
    toOutgoing,
  };
}

/** Last path segment — what a pin chip shows (the full path is its title). */
export function pinName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

/** Compact byte size for a chip's tooltip, mirroring v1's `fmtBytes`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
