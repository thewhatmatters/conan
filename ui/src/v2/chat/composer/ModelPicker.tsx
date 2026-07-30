/**
 * ModelPicker — the composer's provider · model control.
 *
 * DESIGN: Paper artboard `122-1` ("Provider/Model Selector", 406×245, max-h
 * 480). Two columns inside one 12px-radius panel:
 *   14F-1  rail   — icon-only providers (32×32, 10px radius, selected wash)
 *   13M-1  main   — search row (126-1, bottom border) over the model list
 *   12K-1  row    — title + description, a ⌘N chip trailing; the SELECTED row
 *                   takes a #FFFFFF0D wash AND the 2px accent bar, the same
 *                   selected language as the sidebar's thread rows
 *   12U-1  footer — ↑↓ Navigate · ↵ Select · Esc Close
 *
 * EFFORT IS NOT HERE — it moved to its sibling `EffortChip`. provider+model is
 * the thread's IDENTITY (a resumed thread relaunches its saved provider), so
 * this control LOCKS after turn 1; effort is a per-turn parameter and must stay
 * changeable, which fusing them (v1's shape) prevented.
 *
 * v1 behaviours kept, because each still earns its place:
 *   - the rail only BROWSES; every commit happens from the model list, so the
 *     interaction is uniform no matter which provider you land on;
 *   - a provider exposing only its default degrades to one honest commit row
 *     rather than an empty panel;
 *   - locked degrades to a static indicator with a lock — never a dead dropdown.
 */
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Popover } from "@astryxdesign/core/Popover";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { Kbd } from "@astryxdesign/core/Kbd";
import { useHotkeys } from "@astryxdesign/core/hooks";
import { Lock, Search } from "lucide-react";
import ProviderGlyph from "./ProviderGlyph.tsx";
import {
  pickerLabel,
  providerBrand,
  type ProviderStatus,
} from "../../lib/useV2Providers.ts";

export interface ModelPickerProps {
  /** Registry rows (`GET /api/agent/providers`). Empty until the fetch lands. */
  providers: ProviderStatus[];
  /** The provider this thread is (or will be) driving. */
  activeProviderId: string;
  /** Display name for the trigger while the registry is still empty. */
  activeProviderName?: string;
  /** The selected `-m` value, or undefined for the provider's own default. */
  model: string | undefined;
  /** Turn 2+ (or a resumed thread): the launch config is fixed. */
  locked?: boolean;
  onSelect: (providerId: string, model: string | undefined) => void;
}

const styles = stylex.create({
  // TY-0 — the trigger pill. ChatComposer applies `pointer-events: none` when
  // disabled; the trigger keeps its own so the locked face stays inspectable.
  trigger: {
    borderRadius: "var(--conan-radius-pill)",
    height: "var(--conan-control-height)",
    paddingInline: "var(--conan-space-3)",
    pointerEvents: "auto",
  },
  // The locked face: same geometry, no affordance.
  locked: {
    borderRadius: "var(--conan-radius-pill)",
    color: "var(--conan-text-muted)",
    height: "var(--conan-control-height)",
  },
  // Astryx's popover surface pads its content 12px. The artboard's dividers
  // (rail edge, search rule, footer rule) run EDGE TO EDGE, so that padding has
  // to go or every rule stops short of the rounded corner.
  surface: {
    padding: 0,
  },
  // 122-1 — fixed width, capped height. A menu that resizes as you browse
  // providers reads as a glitch, so only the list scrolls. It owns the panel
  // fill + radius now that it sits flush against the popover's edge.
  panel: {
    backgroundColor: "var(--conan-color-content)",
    borderRadius: "var(--conan-radius-lg)",
    maxHeight: "480px",
    overflow: "hidden",
    // The panel renders inside ChatComposer's subtree, so its disabled
    // `pointer-events: none` cascades here too. The trigger already opts back
    // in; without the same on the panel you could OPEN the picker while the
    // socket is down but not click anything in it — worse than not opening.
    pointerEvents: "auto",
    width: "406px",
  },
  columns: {
    minHeight: 0,
  },
  // 14F-1 — the icon rail.
  rail: {
    borderInlineEndColor: "var(--conan-color-border)",
    borderInlineEndStyle: "solid",
    borderInlineEndWidth: "var(--conan-border-width)",
    flexShrink: 0,
    rowGap: "var(--conan-space-1h)",
  },
  railButton: {
    borderRadius: "var(--conan-radius-md)",
    height: "var(--conan-control-height)",
    width: "var(--conan-control-height)",
  },
  main: {
    minWidth: 0,
  },
  // 126-1 — the search row sits over the list, separated by a hairline.
  search: {
    borderBlockEndColor: "var(--conan-color-border)",
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: "var(--conan-border-width)",
    flexShrink: 0,
  },
  // A bare input: the field chrome IS the row, so a bordered TextInput would
  // double the frame the design already draws with the hairline above.
  searchInput: {
    backgroundColor: "transparent",
    borderWidth: 0,
    color: "var(--conan-text-primary)",
    fontFamily: "var(--conan-font-sans)",
    fontSize: "var(--conan-text-body)",
    minWidth: 0,
    outline: "none",
    width: "100%",
    "::placeholder": { color: "var(--conan-text-muted)" },
  },
  scroller: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
  },
  // 12K-1 — one model row. Native button + Astryx layout, the same shape the
  // sidebar's ThreadRow uses for a custom-styled selectable row.
  row: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
    },
    borderRadius: "var(--conan-radius-sm)",
    borderWidth: 0,
    cursor: "pointer",
    display: "block",
    padding: 0,
    position: "relative",
    textAlign: "start",
    width: "100%",
  },
  rowSelected: {
    backgroundColor: "var(--conan-wash-hover)",
  },
  rowBody: {
    minWidth: 0,
  },
  // 16W-1 — the 2px selected bar, inset 4px, same language as the thread row.
  indicator: {
    backgroundColor: "var(--conan-color-accent)",
    borderRadius: "var(--conan-radius-full)",
    height: "var(--conan-indicator-height)",
    insetBlockEnd: 0,
    insetInlineEnd: "var(--conan-space-1)",
    insetInlineStart: "var(--conan-space-1)",
    position: "absolute",
  },
  // 12U-1 — keyboard hints.
  footer: {
    borderBlockStartColor: "var(--conan-color-border)",
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: "var(--conan-border-width)",
    flexShrink: 0,
  },
});

const GLYPH = 16;
/** Only the first nine rows get a ⌘N chip — past that the digits run out. */
const MAX_SHORTCUTS = 9;

export default function ModelPicker({
  providers,
  activeProviderId,
  activeProviderName = "Claude Code",
  model,
  locked = false,
  onSelect,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  // Which provider's models the panel shows — browsing only, distinct from the
  // committed `activeProviderId` until the user picks a row.
  const [browsed, setBrowsed] = useState(activeProviderId);
  const [query, setQuery] = useState("");

  const active = providers.find((p) => p.id === activeProviderId);
  const activeLetter = active?.avatarLetter ?? activeProviderId.charAt(0).toUpperCase();
  // Effort is no longer part of the trigger label — it has its own chip.
  const label = pickerLabel(active, activeProviderName, model, "");

  const browsedProvider = providers.find((p) => p.id === browsed);
  const browsedModels = browsedProvider?.capabilities.models ?? [];
  const filtered = browsedModels.filter((m) =>
    `${m.label} ${m.description ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  const commit = (providerId: string, value: string | undefined) => {
    onSelect(providerId, value);
    setOpen(false);
  };

  // ⌘1…⌘9 commit the matching row, mirroring the chips the design draws. The
  // hook is always mounted (hooks can't be conditional) and simply disabled
  // while the panel is closed.
  useHotkeys(
    filtered.slice(0, MAX_SHORTCUTS).map((m, i) => ({
      keys: `mod+${i + 1}`,
      allowInInputs: true,
      isDisabled: !open || locked,
      onPress: () => commit(browsed, m.value ?? undefined),
    })),
  );

  if (locked) {
    return (
      <HStack
        align="center"
        gap={2}
        paddingInline={3}
        xstyle={styles.locked}
        data-slot="model-picker-locked"
        aria-label={`${label} — locked for this thread`}
      >
        <ProviderGlyph providerId={activeProviderId} letter={activeLetter} size={GLYPH} />
        <Text type="body" weight="medium" color="primary" maxLines={1}>
          {label}
        </Text>
        <Lock size={12} aria-hidden />
      </HStack>
    );
  }

  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        // Reset the rail + query on open so the panel never reopens mid-browse.
        if (next) {
          setBrowsed(activeProviderId);
          setQuery("");
        }
        setOpen(next);
      }}
      placement="above"
      alignment="start"
      label="Choose provider and model"
      xstyle={styles.surface}
      content={
        <VStack gap={0} xstyle={styles.panel} data-slot="model-picker-panel">
          <HStack gap={0} xstyle={styles.columns}>
            {providers.length > 1 ? (
              <VStack align="center" padding={2} xstyle={styles.rail}>
                {providers.map((p) => (
                  <Button
                    key={p.id}
                    variant={p.id === browsed ? "secondary" : "ghost"}
                    size="sm"
                    isIconOnly
                    isDisabled={!p.installed}
                    label={p.installed ? p.name : `${p.name} — not found on PATH`}
                    icon={
                      <ProviderGlyph
                        providerId={p.id}
                        letter={p.avatarLetter}
                        size={GLYPH}
                      />
                    }
                    onClick={() => setBrowsed(p.id)}
                    xstyle={styles.railButton}
                    data-provider={p.id}
                  />
                ))}
              </VStack>
            ) : null}

            <VStack gap={0} width="100%" xstyle={styles.main}>
              {browsedModels.length > 1 ? (
                <>
                  <HStack
                    align="center"
                    gap={2}
                    paddingBlock={3}
                    paddingInline={4}
                    xstyle={styles.search}
                  >
                    <Search size={GLYPH} aria-hidden />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search…"
                      aria-label="Search models"
                      {...stylex.props(styles.searchInput)}
                    />
                  </HStack>
                  <VStack gap={0} padding={1} xstyle={styles.scroller}>
                    {filtered.map((m, i) => {
                      const value = m.value ?? undefined;
                      const isSelected =
                        browsed === activeProviderId && value === model;
                      return (
                        <button
                          key={m.label}
                          type="button"
                          onClick={() => commit(browsed, value)}
                          aria-current={isSelected ? "true" : undefined}
                          {...stylex.props(
                            styles.row,
                            isSelected && styles.rowSelected,
                          )}
                          data-slot="model-row"
                          data-selected={isSelected ? "true" : undefined}
                        >
                          <HStack
                            align="center"
                            gap={3}
                            paddingBlock={2}
                            paddingInline={3}
                          >
                            <VStack gap={0} width="100%" xstyle={styles.rowBody}>
                              <Text weight="medium" color="primary" maxLines={1}>
                                {m.label}
                              </Text>
                              <Text type="supporting" color="secondary" maxLines={1}>
                                {m.description ??
                                  providerBrand(browsedProvider?.name ?? "")}
                              </Text>
                            </VStack>
                            {i < MAX_SHORTCUTS ? (
                              <Kbd keys={`mod+${i + 1}`} />
                            ) : null}
                          </HStack>
                          {isSelected ? (
                            <HStack xstyle={styles.indicator} aria-hidden />
                          ) : null}
                        </button>
                      );
                    })}
                  </VStack>
                </>
              ) : (
                // Only a default model exposed — one honest commit row, not an
                // empty panel (v1's degrade).
                <VStack gap={2} padding={3}>
                  <Text type="supporting" color="secondary">
                    {browsedProvider?.name ?? "This provider"} runs on its own
                    default model — no other model to choose here.
                  </Text>
                  <Button
                    variant="primary"
                    size="sm"
                    label={`Use ${browsedProvider?.name ?? "this provider"}`}
                    onClick={() => commit(browsed, undefined)}
                  />
                </VStack>
              )}
            </VStack>
          </HStack>

          {/* 12W-1 — LEFT aligned, padding 8/16, 16px between groups and 4px
              inside one. Centring it drifts from the artboard. */}
          <HStack
            align="center"
            gap={4}
            paddingBlock={2}
            paddingInline={4}
            xstyle={styles.footer}
            aria-hidden
          >
            <HStack align="center" gap={1}>
              <Kbd keys="up" />
              <Kbd keys="down" />
              <Text type="supporting" color="secondary">
                Navigate
              </Text>
            </HStack>
            <HStack align="center" gap={1}>
              <Kbd keys="enter" />
              <Text type="supporting" color="secondary">
                Select
              </Text>
            </HStack>
            <HStack align="center" gap={1}>
              <Kbd keys="escape" />
              <Text type="supporting" color="secondary">
                Close
              </Text>
            </HStack>
          </HStack>
        </VStack>
      }
    >
      <Button
        variant="ghost"
        size="md"
        label={label}
        icon={
          <ProviderGlyph
            providerId={activeProviderId}
            letter={activeLetter}
            size={GLYPH}
          />
        }
        endContent={<Icon icon="chevronDown" size="sm" />}
        xstyle={styles.trigger}
        data-slot="model-picker"
      />
    </Popover>
  );
}
