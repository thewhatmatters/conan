/**
 * Provider brand marks by provider id — the ONE map both trees render from
 * (v1's `ProviderMark`, v2's `ProviderGlyph`). The Codex icon is the OpenAI
 * mark. Inlined via `?raw` (not `<img>`) so `currentColor` marks inherit the
 * wrapper's color while self-colored marks (Claude, Kimi) keep their brand
 * value. Kept separate from `model.ts` so the domain module stays free of
 * bundler-specific imports.
 *
 * A provider with no entry falls back to its registry avatar letter — the
 * honest thing to show for a mark we don't ship.
 */
import claudeIcon from "../assets/providers/claude.svg?raw";
import grokIcon from "../assets/providers/grok.svg?raw";
import openaiIcon from "../assets/providers/openai.svg?raw";
import kimiIcon from "../assets/providers/kimi.svg?raw";

export const PROVIDER_ICON: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  grok: grokIcon,
  kimi: kimiIcon,
};
