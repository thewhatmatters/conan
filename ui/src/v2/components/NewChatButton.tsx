/**
 * NewChatButton — the sidebar footer's primary action.
 *
 * T0 STUB (owned by US-004).
 *
 * ⚠️ NOT DRAWN ON RJ-0. `prd-conan-v2-astryx.json` maps this slot to node 7W-0,
 * but 7W-0 on the current artboard is the **Settings** button — the footer frame
 * (7L-0) holds Settings and nothing else. What RJ-0 does give us is the shape of
 * that frame: 7L-0 wraps its buttons in a `gap: 4` row (7M-0), i.e. a row built
 * for more than one. So this button is drawn in 7W-0's exact idiom — 32px tall,
 * 16px pill radius, 8/12 padding, a 16px icon and a 14px medium label in the
 * primary tone — and seated beside Settings in that row.
 *
 * Flagged rather than silently invented: if the artboard later gains a real
 * New-chat treatment, this file is the only thing that changes.
 */
import * as stylex from "@stylexjs/stylex";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { MessageSquarePlus } from "lucide-react";

const styles = stylex.create({
  // 7W-0's idiom: a pill, not the 10px radius the rest of the shell uses. The
  // footer is the one place RJ-0 rounds a control this far.
  button: {
    borderRadius: "var(--conan-radius-pill)",
    color: "var(--conan-icon-primary)",
    flexShrink: 0,
    height: "var(--conan-control-height)",
  },
});

export default function NewChatButton() {
  return (
    <HStack
      align="center"
      gap={2}
      paddingBlock={2}
      paddingInline={3}
      xstyle={styles.button}
      data-slot="new-chat-button"
    >
      <MessageSquarePlus size={16} aria-hidden />
      <Text weight="medium" color="primary" maxLines={1}>
        New chat
      </Text>
    </HStack>
  );
}
