import { useEffect, useRef } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { SaganRunDetail } from "../../../../src/sagan/api.ts";

const styles = stylex.create({
  root: {
    alignItems: "stretch",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    paddingBlockStart: "var(--conan-secondary-bar-height)",
    width: "100%",
  },
  header: {
    borderBottom: "var(--conan-border-width) solid var(--conan-color-border)",
    flexShrink: 0,
    padding: "var(--conan-space-4)",
  },
  closeButton: {
    alignItems: "center",
    appearance: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--conan-wash-hover)",
      ":active": "var(--conan-wash-pressed)",
    },
    border: 0,
    borderRadius: "var(--conan-radius-md)",
    color: "var(--conan-text-primary)",
    cursor: "pointer",
    display: "inline-flex",
    gap: "var(--conan-space-2)",
    outline: { default: null, ":focus-visible": "2px solid var(--conan-color-accent)" },
    outlineOffset: "var(--conan-space-hair)",
    padding: "var(--conan-space-2)",
  },
  scroller: {
    alignItems: "stretch",
    flexGrow: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "var(--conan-space-4)",
  },
  facts: {
    display: "grid",
    gap: "var(--conan-space-3)",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    width: "100%",
  },
  fact: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-md)",
    minWidth: 0,
    padding: "var(--conan-space-3)",
  },
  value: { overflowWrap: "anywhere" },
  section: { alignItems: "stretch", width: "100%" },
  artifact: {
    backgroundColor: "var(--conan-wash-raised)",
    borderRadius: "var(--conan-radius-md)",
    fontFamily: "var(--conan-font-mono)",
    overflowWrap: "anywhere",
    padding: "var(--conan-space-3)",
  },
  event: {
    borderInlineStart: "var(--conan-border-width) solid var(--conan-color-border-strong)",
    paddingBlock: "var(--conan-space-2)",
    paddingInlineStart: "var(--conan-space-3)",
  },
  eventBody: {
    fontFamily: "var(--conan-font-mono)",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  center: { flexGrow: 1, minHeight: 0 },
});

const display = (value: string | number | null | undefined): string =>
  value == null || value === "" ? "Not recorded" : String(value);

const formatTime = (value: string | null): string => {
  if (!value) return "Not recorded";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
};

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <VStack gap={1} xstyle={styles.fact}>
      <Text color="secondary" type="supporting">{label}</Text>
      <Text xstyle={styles.value}>{display(value)}</Text>
    </VStack>
  );
}

function eventBody(data: Record<string, unknown>): string {
  const details = Object.fromEntries(
    Object.entries(data).filter(([key]) => !["event", "ticket", "ts", "timestamp"].includes(key)),
  );
  return Object.keys(details).length > 0 ? JSON.stringify(details, null, 2) : "No additional fields";
}

export default function SaganInspector({
  run,
  loading,
  error,
  onClose,
  onOpenOwningTarget,
}: {
  run: SaganRunDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpenOwningTarget?: (id: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const artifacts = run
    ? [
        ...run.lanes.flatMap((lane) => lane.artifact ? [lane.artifact] : []),
        ...run.evidence.flatMap((entry) => entry.artifacts),
        ...run.history.flatMap((entry) => {
          const output = entry.data.output;
          return typeof output === "string" && output ? [output] : [];
        }),
      ]
    : [];
  const uniqueArtifacts = [...new Set(artifacts)];
  const status = run
    ? run.openDecisions.length > 0
      ? "Awaiting decision"
      : run.verdict ?? run.phase ?? run.lane
    : null;

  return (
    <VStack gap={0} xstyle={styles.root} data-sagan-pane="inspector" aria-label="Run inspector">
      <HStack align="center" justify="between" gap={3} xstyle={styles.header}>
        <button ref={closeRef} type="button" onClick={onClose} {...stylex.props(styles.closeButton)}>
          <ArrowLeft size={16} aria-hidden />
          <Text weight="semibold">Overview</Text>
        </button>
        {run?.context.owningTarget ? (
          <Button
            label="Open owning thread/session"
            icon={<ExternalLink size={16} aria-hidden />}
            variant="secondary"
            clickAction={() => onOpenOwningTarget?.(run.context.owningTarget!.id)}
          />
        ) : null}
      </HStack>
      {loading ? (
        <VStack align="center" justify="center" gap={2} xstyle={styles.center}>
          <Spinner label="Loading run inspector" />
        </VStack>
      ) : error || !run ? (
        <VStack align="center" justify="center" gap={2} xstyle={styles.center}>
          <Text color="secondary">{error ?? "Run details are unavailable."}</Text>
        </VStack>
      ) : (
        <VStack gap={5} xstyle={styles.scroller}>
          <VStack gap={1} xstyle={styles.section}>
            <Text type="supporting" color="secondary">{run.ticket}</Text>
            <Text weight="semibold">{display(run.context.objective)}</Text>
          </VStack>
          <VStack gap={3} xstyle={styles.facts}>
            <Fact label="Lane" value={run.lane} />
            <Fact label="Role" value={run.agent?.role} />
            <Fact label="Assigned agent" value={run.agent?.name} />
            <Fact label="Provider" value={run.context.provider} />
            <Fact label="Containment" value={run.context.containment} />
            <Fact label="Status" value={status} />
            <Fact label="Ticket ID" value={run.ticket} />
            <Fact label="Attempt ID" value={run.context.attemptId} />
            <Fact label="Started" value={formatTime(run.firstTs)} />
            <Fact label="Last updated" value={formatTime(run.lastTs)} />
          </VStack>
          <VStack gap={2} xstyle={styles.section}>
            <Text weight="semibold">Output & artifacts</Text>
            {uniqueArtifacts.length > 0 ? uniqueArtifacts.map((artifact) => (
              <Text key={artifact} type="supporting" xstyle={styles.artifact}>{artifact}</Text>
            )) : <Text color="secondary">No output or artifacts recorded.</Text>}
          </VStack>
          <VStack gap={2} xstyle={styles.section}>
            <HStack align="center" justify="between" gap={2}>
              <Text weight="semibold">Transcript</Text>
              <Text color="secondary" type="supporting">Read only · {run.history.length} events</Text>
            </HStack>
            {run.history.map((entry) => (
              <VStack key={entry.index} gap={1} xstyle={styles.event}>
                <HStack align="center" justify="between" gap={2}>
                  <Text weight="semibold">{entry.event}</Text>
                  <Text color="secondary" type="supporting">{formatTime(entry.ts)}</Text>
                </HStack>
                <Text color="secondary" type="supporting" xstyle={styles.eventBody}>
                  {eventBody(entry.data)}
                </Text>
              </VStack>
            ))}
          </VStack>
        </VStack>
      )}
    </VStack>
  );
}
