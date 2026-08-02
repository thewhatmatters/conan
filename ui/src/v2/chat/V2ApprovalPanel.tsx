/**
 * Approval CONTENT — what the agent is asking about (p2b US-604, reshaped by
 * WHA-86).
 *
 * This used to be the whole prompt: a Card that replaced the composer, owning
 * its own live region and action row. WHA-86 moved the container and the
 * actions into `V2ApprovalGate` (a drawer that rises out of a composer which
 * stays mounted), and what is left here is the part that was always the point —
 * rendering WHAT is being approved: a plan, a file diff, a structured tool
 * summary, or the raw detail.
 *
 * It deliberately no longer carries `aria-live`. The gate owns announcement now,
 * because a region that is inserted rather than mutated is exactly the defect
 * WHA-55 describes.
 */
import * as stylex from "@stylexjs/stylex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { buildFileDiff } from "../../lib/diff.ts";
import V2DiffView from "../components/V2DiffView.tsx";
import type { PendingApproval } from "../lib/useV2Chat.ts";

/** Max rows in the non-file-tool structured summary. */
const MAX_SUMMARY_ROWS = 6;
/** Per-value truncation in the structured summary. */
const MAX_SUMMARY_VALUE = 200;

/** Distill a non-file tool's raw input into label/value rows (Randy's
 *  decision #4 — "a short structured summary" instead of raw JSON). Keeps
 *  only primitive top-level fields; returns null when nothing usable
 *  survives, and the card falls back to the `detail` mono block. */
export function summarizeToolInput(
  input: unknown,
): { label: string; value: string }[] | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return null;
  const rows: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (rows.length >= MAX_SUMMARY_ROWS) break;
    let value: string;
    if (typeof raw === "string") {
      if (!raw.trim()) continue;
      value = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      value = String(raw);
    } else {
      continue; // nested objects/arrays stay out of the "short" summary
    }
    if (value.length > MAX_SUMMARY_VALUE) value = `${value.slice(0, MAX_SUMMARY_VALUE)}…`;
    rows.push({ label: key, value });
  }
  return rows.length > 0 ? rows : null;
}

const styles = stylex.create({
  detail: {
    boxSizing: "border-box",
    margin: 0,
    maxHeight: 160,
    overflow: "auto",
    overflowWrap: "anywhere",
    padding: "var(--conan-space-3)",
    whiteSpace: "pre-wrap",
    width: "100%",
  },
  diffWrap: {
    boxSizing: "border-box",
    padding: "var(--conan-space-3)",
    width: "100%",
  },
  summaryValue: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    margin: 0,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
  },
  plan: {
    boxSizing: "border-box",
    maxHeight: 320,
    overflow: "auto",
    overflowWrap: "anywhere",
    padding: "var(--conan-space-3)",
    width: "100%",
  },
  planHeading: {
    fontSize: "inherit",
    fontWeight: 600,
    marginBlock: "var(--conan-space-2)",
  },
  planParagraph: {
    marginBlock: "var(--conan-space-2)",
  },
});

export interface V2ApprovalContentProps {
  approval: PendingApproval;
  /** Queue depth — shown as "1 of N" when more than one is waiting. */
  count: number;
}

export default function V2ApprovalContent({
  approval,
  count,
}: V2ApprovalContentProps) {
  const isPlan = approval.toolName === "ExitPlanMode";
  // Defect 2: a file edit renders as a real diff; other tools get a short
  // structured summary of their input; anything else keeps the mono block.
  const diff = isPlan ? null : buildFileDiff(approval.toolName, approval.input);
  const summary = isPlan || diff ? null : summarizeToolInput(approval.input);

  return (
    <VStack gap={3} data-slot="v2-approval-content">
        <HStack gap={2} align="center" justify="between">
          <VStack gap={1}>
            <Text type="body" weight="medium">
              {isPlan ? "Plan ready" : "Permission needed"}
            </Text>
            <Text type="supporting" color="secondary">
              {isPlan
                ? "Review the proposed plan, then choose whether the agent should continue."
                : `${approval.toolName} · ${approval.summary}`}
            </Text>
          </VStack>
          {count > 1 ? (
            <Text type="supporting" color="secondary" hasTabularNumbers>
              1 of {count}
            </Text>
          ) : null}
        </HStack>

        {isPlan ? (
          <Card variant="muted" padding={0} width="100%">
            <div {...stylex.props(styles.plan)}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: (props) => <h2 {...props} {...stylex.props(styles.planHeading)} />,
                  h2: (props) => <h3 {...props} {...stylex.props(styles.planHeading)} />,
                  h3: (props) => <h4 {...props} {...stylex.props(styles.planHeading)} />,
                  p: (props) => <p {...props} {...stylex.props(styles.planParagraph)} />,
                  a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                }}
              >
                {approval.detail}
              </ReactMarkdown>
            </div>
          </Card>
        ) : diff ? (
          <Card variant="muted" padding={0} width="100%">
            <div {...stylex.props(styles.diffWrap)}>
              <V2DiffView diff={diff} />
            </div>
          </Card>
        ) : summary ? (
          <Card variant="muted" padding={0} width="100%">
            <VStack gap={1} data-slot="v2-tool-summary" xstyle={styles.diffWrap}>
              {summary.map((row) => (
                <VStack key={row.label} gap={0}>
                  <Text type="supporting" color="secondary">
                    {row.label}
                  </Text>
                  <pre {...stylex.props(styles.summaryValue)}>{row.value}</pre>
                </VStack>
              ))}
            </VStack>
          </Card>
        ) : (
          <Card variant="muted" padding={0} width="100%">
            <pre {...stylex.props(styles.detail)}>{approval.detail}</pre>
          </Card>
        )}

    </VStack>
  );
}
