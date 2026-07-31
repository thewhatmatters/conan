/**
 * Supervised-mode permission prompt (p2b US-604).
 *
 * Replaces the composer while the driver is blocked. The four actions map
 * directly to PermissionDecision; this component does not invent approval
 * state or duplicate the socket protocol owned by useAgentChat.
 */
import * as stylex from "@stylexjs/stylex";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type {
  PendingApproval,
  PermissionDecision,
} from "../lib/useV2Chat.ts";

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
  actions: {
    flexWrap: "wrap",
  },
});

export interface V2ApprovalPanelProps {
  approval: PendingApproval;
  count: number;
  respond: (id: string, decision: PermissionDecision) => void;
}

export default function V2ApprovalPanel({
  approval,
  count,
  respond,
}: V2ApprovalPanelProps) {
  const decide = (decision: PermissionDecision) =>
    respond(approval.id, decision);
  const isPlan = approval.toolName === "ExitPlanMode";

  return (
    <Card
      data-slot="v2-approval-panel"
      role="region"
      aria-label={isPlan ? "Plan approval" : "Permission needed"}
      padding={4}
      width="100%"
    >
      <VStack gap={3}>
        <HStack gap={2} align="center" justify="between">
          <VStack gap={1}>
            <Text type="body" weight="medium">
              {isPlan ? "Plan ready" : "Permission needed"}
            </Text>
            <Text type="supporting" color="secondary">
              {isPlan
                ? "Review the plan above, then choose whether the agent should continue."
                : `${approval.toolName} · ${approval.summary}`}
            </Text>
          </VStack>
          {count > 1 ? (
            <Text type="supporting" color="secondary" hasTabularNumbers>
              1 of {count}
            </Text>
          ) : null}
        </HStack>

        {!isPlan ? (
          <Card variant="muted" padding={0} width="100%">
            <pre {...stylex.props(styles.detail)}>{approval.detail}</pre>
          </Card>
        ) : null}

        <HStack gap={2} align="center" xstyle={styles.actions}>
          <Button
            label={isPlan ? "Proceed in build" : "Approve once"}
            variant="primary"
            size="sm"
            onClick={() => decide("accept")}
          />
          {!isPlan ? (
            <Button
              label="Always allow this session"
              variant="secondary"
              size="sm"
              onClick={() => decide("acceptForSession")}
            />
          ) : null}
          <Button
            label={isPlan ? "Keep planning" : "Decline"}
            variant="secondary"
            size="sm"
            onClick={() => decide("decline")}
          />
          <Button
            label="Cancel turn"
            variant="destructive"
            size="sm"
            onClick={() => decide("cancel")}
          />
        </HStack>
      </VStack>
    </Card>
  );
}
