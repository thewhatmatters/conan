/**
 * PinsDrawer — the composer's attachment drawer. Paper `S5-0` nodes S6-0
 * (drawer), S7-0 (toggle row), SF-0/SG-0/SH-0 (a pin chip + its ✕).
 *
 * The artboard was drawn ON Astryx's own components, so this is a near-1:1
 * compose rather than a port: `ChatComposerDrawer` already paints S6-0 exactly
 * (16px inline / 12px top padding, 28px top corners, surface + muted tint, the
 * count badge ⇄ collapse-handle crossfade of S7-0), and `Token` at its default
 * size is SF-0 exactly (24px tall = `--size-element-md` − 8, 8px inline
 * padding, 4px gap, `--radius-inner` 6px, 12/500 label) with `onRemove`
 * rendering SH-0's ✕. Verified against `get_computed_styles` on those nodes —
 * no `xstyle` is needed here, and adding one would be re-drawing what the
 * component already draws.
 *
 * Images ride the same drawer: the artboard draws only file chips, but a
 * pasted image is staged for the same turn, and one "Items" count is the
 * honest read of what rides along.
 */
import { ChatComposerDrawer } from "@astryxdesign/core/Chat";
import { Token } from "@astryxdesign/core/Token";
import { Image as ImageIcon } from "lucide-react";
import type { OutgoingImage } from "../../../hooks/useAgentChat.ts";
import { fmtBytes, pinName, type V2Pin } from "../../lib/useComposerAttachments.ts";

export interface PinsDrawerProps {
  pins: V2Pin[];
  images?: OutgoingImage[];
  onRemovePin: (path: string) => void;
  onRemoveImage?: (index: number) => void;
}

const ICON = 12;

export default function PinsDrawer({
  pins,
  images = [],
  onRemovePin,
  onRemoveImage,
}: PinsDrawerProps) {
  const count = pins.length + images.length;
  // Nothing staged → no drawer at all. An empty drawer would still paint its
  // 28px surface band above the composer, which the artboard only shows when
  // there are items.
  if (count === 0) return null;

  return (
    <ChatComposerDrawer count={count} label="Items" data-slot="pins-drawer">
      {pins.map((pin) => (
        <Token
          key={pin.path}
          label={pinName(pin.path)}
          description={`${pin.path} · ${fmtBytes(pin.bytes)}${
            pin.truncated ? " · truncated" : ""
          }`}
          onRemove={() => onRemovePin(pin.path)}
        />
      ))}
      {images.map((image, i) => (
        <Token
          key={`image-${i}`}
          label={`Image ${i + 1}`}
          description={image.mediaType}
          icon={<ImageIcon size={ICON} aria-hidden />}
          onRemove={() => onRemoveImage?.(i)}
        />
      ))}
    </ChatComposerDrawer>
  );
}
