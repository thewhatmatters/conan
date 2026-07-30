/**
 * ModelPicker — the composer's provider · model · effort control.
 *
 * DESIGN: the TRIGGER is drawn on the artboard (S5-0 node TY-0 — brand
 * asterisk UV-0 + "Claude Fable 5" U2-0 + chevron U3-0; 32px pill, 16px
 * radius, 8/12 padding, 8 gap, label 14/500 #FAFAFA). The OPEN state is not
 * drawn, so its BEHAVIOUR is ported from v1's `ProviderModelPicker`
 * (ui/src/components/ProviderModelPicker.tsx) and its PARTS are Astryx:
 * Popover + List/ListItem + Button + TextInput. No Radix, no shadcn.
 *
 * v1 behaviours kept, because each earns its place:
 *   - the rail only BROWSES; every commit happens from the model panel, so the
 *     interaction is uniform no matter which provider you land on;
 *   - a provider exposing only its default degrades to one honest commit row
 *     rather than an empty panel;
 *   - effort lives behind a fly-out so the menu keeps a fixed size;
 *   - locked (turn 2+, or a resumed thread) degrades to a static indicator
 *     with a lock — never a dead dropdown.
 *
 * The effort fly-out is a SECOND Popover anchored on the footer row, matching
 * v1's shape. Astryx's Popover is built on the native Popover API, so the
 * nested layer dismisses independently of its parent.
 */
import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Popover } from "@astryxdesign/core/Popover";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Lock } from "lucide-react";
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
  /** The selected reasoning-effort id, or "" for the provider default. */
  effort: string;
  /** Turn 2+ (or a resumed thread): the launch config is fixed. */
  locked?: boolean;
  onSelect: (providerId: string, model: string | undefined) => void;
  onEffortSelect: (effort: string) => void;
}

const styles = stylex.create({
  // TY-0 — the trigger pill. Height/radius/padding are the artboard's; the
  // ghost Button supplies the hover wash.
  // ChatComposer applies `pointer-events: none` when disabled; the picker must
  // stay interactive so the user can change provider/model even when the input
  // is locked.
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
  // Fixed panel — v1's 320×416. A menu that resizes as you browse providers
  // reads as a glitch, so the size is pinned and the list scrolls inside it.
  panel: {
    height: "416px",
    width: "320px",
  },
  rail: {
    borderInlineEndColor: "var(--conan-color-border)",
    borderInlineEndStyle: "solid",
    borderInlineEndWidth: "var(--conan-border-width)",
    flexShrink: 0,
    width: "48px",
  },
  railButton: {
    borderRadius: "var(--conan-radius-sm)",
  },
  scroller: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
  },
  footerRow: {
    borderBlockStartColor: "var(--conan-color-border)",
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: "var(--conan-border-width)",
    marginBlockStart: "auto",
  },
  effortPanel: {
    width: "224px",
  },
});

const GLYPH = 16;

export default function ModelPicker({
  providers,
  activeProviderId,
  activeProviderName = "Claude Code",
  model,
  effort,
  locked = false,
  onSelect,
  onEffortSelect,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  // Which provider's models the panel shows — browsing only, distinct from the
  // committed `activeProviderId` until the user picks a row.
  const [browsed, setBrowsed] = useState(activeProviderId);
  const [query, setQuery] = useState("");
  const [effortOpen, setEffortOpen] = useState(false);

  const active = providers.find((p) => p.id === activeProviderId);
  const activeLetter = active?.avatarLetter ?? activeProviderId.charAt(0).toUpperCase();
  const label = pickerLabel(active, activeProviderName, model, effort);
  const effortModes = active?.capabilities.effortModes ?? [];
  const effortLabel = effortModes.find((e) => e.id === effort)?.label;

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

  const browsedProvider = providers.find((p) => p.id === browsed);
  const browsedModels = browsedProvider?.capabilities.models ?? [];
  const filtered = browsedModels.filter((m) =>
    `${m.label} ${m.description ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  // Effort belongs to the ACTIVE provider — showing it while browsing another
  // would set something the user isn't looking at.
  const showEffort = browsed === activeProviderId && effortModes.length > 0;

  const commit = (providerId: string, value: string | undefined) => {
    onSelect(providerId, value);
    setOpen(false);
  };

  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        // Reset the rail to the active provider on open, so it never lingers on
        // a browsed-but-uncommitted one; collapse the fly-out on close.
        if (next) setBrowsed(activeProviderId);
        else setEffortOpen(false);
        setOpen(next);
      }}
      placement="above"
      alignment="start"
      label="Choose provider, model and effort"
      content={
        <HStack gap={0} xstyle={styles.panel} data-slot="model-picker-panel">
          {providers.length > 1 ? (
            <VStack align="center" gap={1} padding={1} xstyle={styles.rail}>
              {providers.map((p) => (
                <Button
                  key={p.id}
                  variant={p.id === browsed ? "secondary" : "ghost"}
                  size="sm"
                  isIconOnly
                  isDisabled={!p.installed}
                  label={
                    p.installed ? p.name : `${p.name} — not found on PATH`
                  }
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

          <VStack gap={0} width="100%">
            {browsedModels.length > 1 ? (
              <>
                <VStack padding={2}>
                  <TextInput
                    label="Search models"
                    isLabelHidden
                    size="sm"
                    placeholder="Search models…"
                    value={query}
                    onChange={setQuery}
                  />
                </VStack>
                <VStack gap={0} xstyle={styles.scroller}>
                  <List density="compact">
                    {filtered.map((m) => {
                      const value = m.value ?? undefined;
                      const isSelected =
                        browsed === activeProviderId && value === model;
                      return (
                        <ListItem
                          key={m.label}
                          label={m.label}
                          description={
                            m.description ??
                            providerBrand(browsedProvider?.name ?? "")
                          }
                          isSelected={isSelected}
                          onClick={() => commit(browsed, value)}
                          endContent={
                            isSelected ? (
                              <Icon icon="check" size="sm" color="accent" />
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </List>
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

            {showEffort ? (
              <VStack gap={0} xstyle={styles.footerRow}>
                <Popover
                  isOpen={effortOpen}
                  onOpenChange={setEffortOpen}
                  placement="end"
                  alignment="end"
                  label="Choose reasoning effort"
                  content={
                    <VStack gap={0} xstyle={styles.effortPanel}>
                      <List density="compact">
                        <ListItem
                          label="Default effort"
                          description="The provider's usual reasoning"
                          isSelected={effort === ""}
                          onClick={() => {
                            onEffortSelect("");
                            setEffortOpen(false);
                          }}
                          endContent={
                            effort === "" ? (
                              <Icon icon="check" size="sm" color="accent" />
                            ) : undefined
                          }
                        />
                        {effortModes.map((e) => (
                          <ListItem
                            key={e.id}
                            label={e.label}
                            description={e.description}
                            isSelected={effort === e.id}
                            onClick={() => {
                              onEffortSelect(e.id);
                              setEffortOpen(false);
                            }}
                            endContent={
                              effort === e.id ? (
                                <Icon icon="check" size="sm" color="accent" />
                              ) : undefined
                            }
                          />
                        ))}
                      </List>
                    </VStack>
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    width="100%"
                    label={`Effort: ${effortLabel ?? "Default"}`}
                    endContent={<Icon icon="chevronRight" size="sm" />}
                    data-slot="effort-trigger"
                  />
                </Popover>
              </VStack>
            ) : null}
          </VStack>
        </HStack>
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
