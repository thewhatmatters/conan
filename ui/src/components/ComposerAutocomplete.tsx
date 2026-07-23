import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils.ts";

/**
 * Reusable composer autocomplete (US-018) — the overlay framework the sigil
 * triggers share: `@` files/folders now, `$` skills (US-019) and `/` commands
 * (US-020) later. Built OVER the plain textarea (no contenteditable): a
 * trigger char typed at a word boundary opens a popover of matches above the
 * composer; ↑/↓ move, Enter/Tab insert, Esc/blur dismiss.
 *
 * The hook re-derives the active trigger from the caret on every change/
 * caret move (`sync`), so deleting back past the trigger or clicking away
 * from the token closes the menu without extra bookkeeping.
 */

export interface AutocompleteItem {
  /** Text that replaces `trigger+query` in the prompt when selected. */
  insert: string;
  /** Primary display (mono). */
  label: string;
  /** Optional secondary display, right-aligned. */
  hint?: string;
  icon: LucideIcon;
}

export interface AutocompleteSource {
  /** Single-char sigil ("@", "$", "/") typed at a word boundary. */
  trigger: string;
  /** Matches for the text typed after the trigger (debounced). */
  fetch: (query: string) => Promise<AutocompleteItem[]>;
  /** Shown while a query has no matches. */
  empty?: string;
}

interface ActiveTrigger {
  source: AutocompleteSource;
  /** Index of the trigger char in the textarea value. */
  start: number;
  query: string;
}

export function useComposerAutocomplete(
  sources: AutocompleteSource[],
  setText: (t: string) => void,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  const [active, setActive] = useState<ActiveTrigger | null>(null);
  const [items, setItems] = useState<AutocompleteItem[]>([]);
  const [index, setIndex] = useState(0);

  /** Re-derive the active trigger from the current caret position. Call on
   *  change AND caret movement (textarea onSelect) — reads el.value directly,
   *  which is already updated when React's onChange fires. */
  const sync = () => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const upto = el.value.slice(0, caret);
    // Nearest trigger before the caret wins when several sigils are present.
    let best: ActiveTrigger | null = null;
    for (const source of sources) {
      const i = upto.lastIndexOf(source.trigger);
      if (i === -1) continue;
      if (i > 0 && !/\s/.test(upto[i - 1]!)) continue; // word boundary only
      const query = upto.slice(i + 1);
      if (/\s/.test(query)) continue; // whitespace after the sigil closes it
      if (!best || i > best.start) best = { source, start: i, query };
    }
    setActive(best);
  };

  // Debounced fetch for the active query; a stale response never lands.
  useEffect(() => {
    if (!active) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      active.source
        .fetch(active.query)
        .then((r) => {
          if (cancelled) return;
          setItems(r);
          setIndex(0);
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.source.trigger, active?.query]);

  const select = (item: AutocompleteItem) => {
    const el = textareaRef.current;
    if (!el || !active) return;
    const caret = el.selectionStart ?? el.value.length;
    const next =
      el.value.slice(0, active.start) + item.insert + " " + el.value.slice(caret);
    setText(next);
    setActive(null);
    const pos = active.start + item.insert.length + 1;
    // Caret lands after the inserted token once React re-renders the value.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /** Give the overlay first refusal on composer keys. Returns true when the
   *  key was consumed (caller must preventDefault and skip its own submit). */
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!active) return false;
    if (e.key === "Escape") {
      setActive(null);
      return true;
    }
    if (items.length === 0) return false; // Enter still submits on no matches
    switch (e.key) {
      case "ArrowDown":
        setIndex((i) => (i + 1) % items.length);
        return true;
      case "ArrowUp":
        setIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      case "Enter":
      case "Tab":
        select(items[index]!);
        return true;
      default:
        return false;
    }
  };

  return {
    open: active != null,
    empty: active?.source.empty,
    items,
    index,
    setIndex,
    sync,
    select,
    onKeyDown,
    dismiss: () => setActive(null),
  };
}

/** The popover itself — absolutely positioned above the composer card (the
 *  parent must be `relative`). Mousedown is swallowed so clicking an item
 *  never blurs the textarea (blur dismisses). */
export function AutocompleteOverlay({
  ac,
}: {
  ac: ReturnType<typeof useComposerAutocomplete>;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [ac.index]);

  if (!ac.open) return null;
  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-md"
    >
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
        {ac.items.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {ac.empty ?? "No matches"}
          </div>
        ) : (
          ac.items.map((it, i) => (
            <button
              key={`${it.insert}-${i}`}
              data-active={i === ac.index}
              onClick={() => ac.select(it)}
              onMouseEnter={() => ac.setIndex(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                i === ac.index ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
            >
              <it.icon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-mono">{it.label}</span>
              {it.hint && (
                <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground/70">
                  {it.hint}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
