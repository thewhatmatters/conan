import { useState } from "react";
import { Check, ChevronDown, Lock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import { cn } from "../lib/utils.ts";
import type { ProviderStatus } from "../hooks/useProviders.ts";

/**
 * The fused provider + model control (T3 `ProviderModelPicker`), replacing the
 * composer's two separate chips (provider US-008 + model). One popover: a
 * provider rail on the left (brand mark + name; uninstalled ones disabled with
 * a reason), and — for the browsed provider — its OWN model list on the right.
 *
 * Each provider's models come from `capabilities.models` (Claude's `/model`
 * aliases, Codex's verified CLI-cache set, Grok's `grok models`), so the panel
 * is provider-specific — no shared Claude list, no provider-name branching. The
 * rail only BROWSES; every commit happens from the right panel, so the
 * interaction is uniform. A provider that exposes only its default (a one-entry
 * list) degrades to a single honest "runs on its default" commit row.
 *
 * Locked (after turn 1, or a resumed thread) it degrades to the same static
 * indicator the chips used — brand mark + label + a lock — never a dead
 * dropdown.
 */
export function ProviderModelPicker({
  providers,
  activeProviderId,
  activeProviderName,
  activeProviderLetter,
  model,
  locked,
  onSelect,
}: {
  /** Full provider list from `GET /api/agent/providers`. */
  providers: ProviderStatus[];
  /** The provider this thread is (or will be) driving. */
  activeProviderId: string;
  /** Display name for the trigger + locked face (survives an empty list). */
  activeProviderName: string;
  /** Avatar letter fallback for the trigger mark. */
  activeProviderLetter: string;
  /** The selected `-m` value, or undefined for the provider default. */
  model: string | undefined;
  locked: boolean;
  /** Commit a provider + model pick (undefined = the provider's own default). */
  onSelect: (providerId: string, model: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  // Which provider's models the right panel shows — browsing only, distinct
  // from the committed `activeProviderId` until the user picks from the panel.
  const [browsed, setBrowsed] = useState(activeProviderId);

  const active = providers.find((p) => p.id === activeProviderId);
  // Optional-chain `models`: a gateway older than the model-selection round
  // omits it, and a missing field must degrade (name only), never white-screen.
  const activeModelLabel = active?.capabilities.models?.find(
    (m) => (m.value ?? undefined) === model,
  )?.label;
  // Trigger face: brand mark + provider name, plus the model when a non-default
  // one is chosen ("Claude Code · Opus"). The default model appends nothing.
  const triggerLabel =
    model !== undefined && activeModelLabel
      ? `${activeProviderName} · ${activeModelLabel}`
      : activeProviderName;

  if (locked) {
    return (
      <span
        title="Locked for this thread — a new chat starts a fresh config"
        className="flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground"
      >
        <ProviderMark id={activeProviderId} letter={activeProviderLetter} className="size-4" />
        {triggerLabel}
        <Lock className="size-3 opacity-60" />
      </span>
    );
  }

  const browsedProvider = providers.find((p) => p.id === browsed);
  const browsedModels = browsedProvider?.capabilities.models ?? [];

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Reset the rail to the active provider each time the popover opens so
        // it never lingers on a browsed-but-not-committed provider.
        if (o) setBrowsed(activeProviderId);
        setOpen(o);
      }}
    >
      <PopoverTrigger className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ProviderMark id={activeProviderId} letter={activeProviderLetter} className="size-4" />
        {triggerLabel}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-96 gap-0 p-0">
        {/* Provider rail */}
        <div className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border p-1.5">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!p.installed}
              title={p.installed ? undefined : `${p.id} not found on PATH`}
              onClick={() => setBrowsed(p.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                p.id === browsed
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                !p.installed && "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
            >
              <ProviderMark id={p.id} letter={p.avatarLetter} className="size-4 shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{p.name}</span>
                {!p.installed && (
                  <span className="text-[11px] text-muted-foreground">not on PATH</span>
                )}
              </div>
              {p.id === activeProviderId && (
                <Check className="ml-auto size-3.5 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>

        {/* Model panel for the browsed provider — its own capabilities.models */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
          {browsedModels.length > 1 ? (
            browsedModels.map((m) => {
              const value = m.value ?? undefined;
              const selected = browsed === activeProviderId && value === model;
              return (
                <button
                  key={m.label}
                  type="button"
                  onClick={() => {
                    onSelect(browsed, value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    selected
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{m.label}</span>
                    {m.description && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {m.description}
                      </span>
                    )}
                  </div>
                  {selected && <Check className="ml-auto mt-0.5 size-3.5 shrink-0 text-primary" />}
                </button>
              );
            })
          ) : (
            // Only a default model exposed — a single honest commit row rather
            // than an empty panel.
            <div className="flex h-full flex-col gap-2 p-1.5">
              <p className="text-[11px] leading-snug text-muted-foreground">
                {browsedProvider?.name ?? "This provider"} runs on its own default
                model — no other model to choose here.
              </p>
              <button
                type="button"
                onClick={() => {
                  onSelect(browsed, undefined);
                  setOpen(false);
                }}
                className="mt-auto flex items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Use {browsedProvider?.name ?? "this provider"}
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
