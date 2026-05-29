import type { ReactNode } from "react";

/**
 * The shared secondary-toolbar strip for HUD tabs (US-004). Renders one flush
 * `border-b border-border` header at a single canonical height/padding with a
 * name slot (left) and an actions slot (right), so every HUD tab — Skills, MCP
 * (and later Pulse/Usage) — reads as the same chrome instead of the old per-tab
 * `h-9` vs `py-2` drift. Kept OUTSIDE each tab's FadeScroll so it stays pinned
 * while the content below it scrolls. Semantic tokens only.
 */
export default function HudTabHeader({
  name,
  actions,
}: {
  /** Left slot — a label, or interactive group tabs (e.g. Skills User/System). */
  name: ReactNode;
  /** Right slot — optional actions (e.g. the MCP ↻ refresh). */
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-border px-2">
      <div className="flex min-w-0 items-center gap-1">{name}</div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </div>
  );
}
