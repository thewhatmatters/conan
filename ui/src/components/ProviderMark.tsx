import claudeIcon from "../assets/providers/claude.svg?raw";
import grokIcon from "../assets/providers/grok.svg?raw";
import openaiIcon from "../assets/providers/openai.svg?raw";
import kimiIcon from "../assets/providers/kimi.svg?raw";
import { cn } from "../lib/utils.ts";

/** Provider brand marks by provider id. The Codex icon is the OpenAI mark.
 *  Inlined via `?raw` (not `<img>`) so the SVG's `currentColor` inherits the
 *  wrapper's text color and the mark flips with light/dark — an `<img>` can't.
 *  A provider with no icon falls back to its avatar letter. Single source of
 *  truth shared by the sidebar avatar (ChatSurface) and the composer's
 *  provider/model picker. */
export const PROVIDER_ICON: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  grok: grokIcon,
  kimi: kimiIcon,
};

/** A provider's brand mark sized to `className`, with a letter fallback for any
 *  provider that ships no SVG. `[&>svg]:size-full` lets the inlined mark fill
 *  the wrapper the caller sizes. */
export function ProviderMark({
  id,
  letter,
  className,
}: {
  id: string;
  letter: string;
  className?: string;
}) {
  const icon = PROVIDER_ICON[id];
  if (icon) {
    return (
      <span
        className={cn("inline-flex items-center justify-center [&>svg]:size-full", className)}
        dangerouslySetInnerHTML={{ __html: icon }}
      />
    );
  }
  return (
    <span className={cn("inline-flex items-center justify-center font-semibold", className)}>
      {letter}
    </span>
  );
}
