import { cn } from "../lib/utils.ts";
// The one brand-mark map both trees share (v2's ProviderGlyph renders the
// same module) — re-exported for this tree's existing importers.
import { PROVIDER_ICON, providerIconOf } from "../chat/providerIcons.ts";

export { PROVIDER_ICON, providerIconOf };

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
  const icon = providerIconOf(id);
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
