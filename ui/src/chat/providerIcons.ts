/**
 * Provider brand marks by provider id — the ONE map both trees render from
 * (v1's `ProviderMark`, v2's `ProviderGlyph`). The Codex icon is the OpenAI
 * mark. Inlined via `?raw` (not `<img>`) so `currentColor` marks inherit the
 * wrapper's color while self-colored marks (Claude, Kimi) keep their brand
 * value. Kept separate from `model.ts` so the domain module stays free of
 * bundler-specific imports.
 *
 * Typed as `Record<ProviderId, string>` so a new provider without a glyph is a
 * compile error (the kimi-class miss that once shipped a bare letter). Free-
 * string wire ids look up via `providerIconOf` and fall back to the registry
 * avatar letter when the id is unknown or pre-migration null.
 */
import type { ProviderId } from "../../../src/agent/driver.ts";
import claudeIcon from "../assets/providers/claude.svg?raw";
import grokIcon from "../assets/providers/grok.svg?raw";
import openaiIcon from "../assets/providers/openai.svg?raw";
import kimiIcon from "../assets/providers/kimi.svg?raw";

export const PROVIDER_ICON: Record<ProviderId, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  grok: grokIcon,
  kimi: kimiIcon,
};

/** Safe lookup for free-string provider ids (wire / pre-narrowed UI state). */
export function providerIconOf(id: string): string | undefined {
  return Object.hasOwn(PROVIDER_ICON, id)
    ? PROVIDER_ICON[id as ProviderId]
    : undefined;
}
