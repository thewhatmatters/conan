import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Lock, Search } from "lucide-react";
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
  effort,
  locked,
  onSelect,
  onEffortSelect,
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
  /** The selected reasoning-effort id, or "" for the provider default. */
  effort: string;
  locked: boolean;
  /** Commit a provider + model pick (undefined = the provider's own default). */
  onSelect: (providerId: string, model: string | undefined) => void;
  /** Commit a reasoning-effort pick ("" = the provider default). */
  onEffortSelect: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Which provider's models the right panel shows — browsing only, distinct
  // from the committed `activeProviderId` until the user picks from the panel.
  const [browsed, setBrowsed] = useState(activeProviderId);
  // Model search (T3-style) — filters the browsed provider's model list.
  const [q, setQ] = useState("");
  // Effort fly-out — a nested popover off the footer row, hidden until clicked
  // so the main menu keeps a fixed size.
  const [showEffort, setShowEffort] = useState(false);

  const active = providers.find((p) => p.id === activeProviderId);
  // Optional-chain `models`: a gateway older than the model-selection round
  // omits it, and a missing field must degrade (name only), never white-screen.
  const activeModelLabel = active?.capabilities.models?.find(
    (m) => (m.value ?? undefined) === model,
  )?.label;
  const activeEffortModes = active?.capabilities.effortModes ?? [];
  const activeEffortLabel = activeEffortModes.find((e) => e.id === effort)?.label;
  // Trigger face: brand mark + brand + the model — model-forward, e.g.
  // "Claude · Opus" (not the CLI product name "Claude Code"). The brand strips a
  // trailing " Code"/" CLI" so the chip reads as the model line the user picks.
  // Model resolution order: the matched entry's label → the raw model value (a
  // gateway too old to send `models`) → "Default" for an untouched pick.
  const brand = activeProviderName.replace(/\s+(Code|CLI)$/i, "");
  const modelText =
    activeModelLabel && activeModelLabel !== "Default model"
      ? activeModelLabel
      : (model ?? "Default");
  // Effort rides in the same trigger, but only when explicitly chosen — a
  // "Default" segment on every chip would just be noise.
  const triggerLabel = activeEffortLabel
    ? `${brand} · ${modelText} · ${activeEffortLabel}`
    : `${brand} · ${modelText}`;

  if (locked) {
    return (
      <span
        title="Locked for this thread — a new chat starts a fresh config"
        className="flex cursor-default items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground"
      >
        <ProviderMark id={activeProviderId} letter={activeProviderLetter} className="size-4" />
        {triggerLabel}
        <Lock className="size-3 opacity-60" />
      </span>
    );
  }

  const browsedProvider = providers.find((p) => p.id === browsed);
  const browsedModels = browsedProvider?.capabilities.models ?? [];
  // The effort footer row (and its fly-out trigger) shows only while browsing
  // the active provider, which is whose effort we'd actually be setting.
  const showEffortPanel = browsed === activeProviderId && activeEffortModes.length > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Reset the rail to the active provider each time the popover opens so
        // it never lingers on a browsed-but-not-committed provider.
        if (o) setBrowsed(activeProviderId);
        // Collapse the effort fly-out when the menu closes so it never reopens
        // already-expanded.
        else setShowEffort(false);
        setOpen(o);
      }}
    >
      <PopoverTrigger className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ProviderMark id={activeProviderId} letter={activeProviderLetter} className="size-4" />
        {triggerLabel}
        <ChevronDown className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex h-[26rem] w-auto overflow-hidden gap-0 p-0">
        {/* Provider rail — icon-only (T3), a vertical strip of brand marks. Only
            shown with >1 provider; a single provider needs no rail. */}
        {providers.length > 1 && (
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border p-1.5">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={!p.installed}
                title={p.installed ? p.name : `${p.name} — not found on PATH`}
                onClick={() => setBrowsed(p.id)}
                className={cn(
                  "relative flex size-8 items-center justify-center rounded-md transition-colors",
                  p.id === browsed
                    ? "bg-muted"
                    : "opacity-70 hover:bg-muted hover:opacity-100",
                  !p.installed && "cursor-not-allowed opacity-30 hover:bg-transparent",
                )}
              >
                <ProviderMark id={p.id} letter={p.avatarLetter} className="size-4 shrink-0" />
                {p.id === activeProviderId && (
                  <span className="absolute inset-y-1 right-0 w-0.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Model panel for the browsed provider — its own capabilities.models,
            rows laid out tabular (T3): model name over a provider sub-line.
            Fixed width; the list scrolls inside the fixed-height menu. */}
        <div className="flex w-64 shrink-0 flex-col">
          {browsedModels.length > 1 ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search models…"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
                {browsedModels
                  .filter((m) => {
                    const hay = `${m.label} ${m.description ?? ""}`.toLowerCase();
                    return hay.includes(q.trim().toLowerCase());
                  })
                  .map((m) => {
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
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                          selected ? "bg-muted" : "hover:bg-muted",
                        )}
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate text-sm text-foreground">{m.label}</span>
                          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <ProviderMark
                              id={browsed}
                              letter={browsedProvider?.avatarLetter ?? "?"}
                              className="size-3 shrink-0"
                            />
                            <span className="truncate">
                              {(browsedProvider?.name ?? "").replace(/\s+(Code|CLI)$/i, "")}
                            </span>
                          </span>
                        </div>
                        {selected && (
                          <Check className="ml-auto size-3.5 shrink-0 text-primary" />
                        )}
                      </button>
                    );
                  })}
              </div>
            </>
          ) : (
            // Only a default model exposed — a single honest commit row rather
            // than an empty panel.
            <div className="flex flex-col gap-2 p-3">
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
                className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Use {browsedProvider?.name ?? "this provider"}
              </button>
            </div>
          )}

          {/* Effort fly-out (Claude-desktop) — the footer row is the trigger for
              a SEPARATE floating card to the right, so the main menu keeps its
              fixed size and the effort options only appear once clicked. */}
          {showEffortPanel && (
            <Popover open={showEffort} onOpenChange={setShowEffort}>
              <PopoverTrigger
                className={cn(
                  "mt-auto flex items-center gap-2 border-t border-border px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:bg-muted",
                  showEffort && "bg-muted",
                )}
              >
                <span className="text-foreground">Effort</span>
                <span className="ml-auto text-muted-foreground">
                  {activeEffortLabel ?? "Default"}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="end"
                sideOffset={6}
                className="flex w-56 flex-col gap-0.5 p-1.5"
              >
                <button
                  type="button"
                  onClick={() => {
                    onEffortSelect("");
                    setShowEffort(false);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                    effort === "" && "bg-muted",
                  )}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm text-foreground">Default effort</span>
                    <span className="text-[11px] text-muted-foreground">
                      The provider's usual reasoning
                    </span>
                  </div>
                  {effort === "" && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
                </button>
                {activeEffortModes.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => {
                      onEffortSelect(e.id);
                      setShowEffort(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                      effort === e.id && "bg-muted",
                    )}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm text-foreground">{e.label}</span>
                      {e.description && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {e.description}
                        </span>
                      )}
                    </div>
                    {effort === e.id && (
                      <Check className="ml-auto size-3.5 shrink-0 text-primary" />
                    )}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
