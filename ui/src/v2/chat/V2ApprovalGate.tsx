/**
 * V2ApprovalGate — the guided-input gate (WHA-86).
 *
 * The composer used to be SWAPPED OUT for the approval panel. That swap is the
 * root of two defects: the live region was inserted rather than updated, so
 * screen readers never announced it (WHA-55), and the user could not type while
 * a decision was pending. Here the composer is the stable anchor and the gate
 * rises out of it as a `ChatComposerDrawer`, so:
 *
 *   - the announcement is a MUTATION of a region that was already mounted, and
 *   - the input keeps its caret, its text and its focusability throughout.
 *
 * OPTIONS ARE BUTTONS, NOT A RADIO GROUP. A radiogroup would be the obvious
 * a11y primitive, but it makes every decision two steps (pick, then confirm)
 * including "approve", which is one press today. Buttons keep the common path
 * at one keystroke; they are natively focusable, so Tab and Enter/Space come
 * from the platform rather than from a hand-rolled roving tabindex.
 *
 * KEY SHORTCUTS ARE SCOPED TO THE GATE. The whole point of this ticket is that
 * the composer stays typeable — so a bare "a" must type an "a" when the caret is
 * in the input. The letter keys only fire while focus is inside the gate, which
 * is where focus lands when the gate opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChatComposerDrawer } from "@astryxdesign/core/Chat";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import V2ApprovalContent from "./V2ApprovalPanel.tsx";
import type { PendingApproval, PermissionDecision } from "../lib/useV2Chat.ts";

/** One keyed option in the gate. `key` is the letter the badge shows. */
interface GateOption {
  key: string;
  label: string;
  decision: PermissionDecision;
  variant: "primary" | "secondary" | "destructive";
  /** Pairs the typed composer text with the decision (decline-with-guidance). */
  sendsGuidance?: boolean;
}

const styles = stylex.create({
  options: {
    paddingBlockStart: "var(--conan-space-2)",
    width: "100%",
  },
  option: {
    width: "100%",
  },
  badge: {
    flexShrink: 0,
  },
  guidanceHint: {
    paddingBlockStart: "var(--conan-space-1)",
  },
  question: {
    border: 0,
    margin: 0,
    padding: 0,
    width: "100%",
  },
  optionLabel: {
    alignItems: "flex-start",
    cursor: "pointer",
    display: "flex",
    gap: "var(--conan-space-2)",
  },
  optionInput: {
    accentColor: "var(--conan-color-accent)",
    marginBlockStart: 3,
  },
  otherInput: {
    backgroundColor: "var(--conan-color-field)",
    border: "1px solid var(--conan-color-border)",
    borderRadius: "var(--conan-radius-sm)",
    boxSizing: "border-box",
    color: "var(--conan-text-primary)",
    minHeight: 36,
    paddingInline: "var(--conan-space-2)",
    width: "100%",
  },
  error: { color: "var(--conan-color-error)" },
});

interface AskOption { label: string; description?: string }
interface AskQuestion { question: string; header?: string; multiSelect: boolean; options: AskOption[] }

export function parseAskUserQuestion(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const value = entry as Record<string, unknown>;
    if (typeof value.question !== "string" || !value.question.trim() || !Array.isArray(value.options)) return null;
    const options = value.options.flatMap((option): AskOption[] => {
      if (!option || typeof option !== "object" || Array.isArray(option)) return [];
      const item = option as Record<string, unknown>;
      return typeof item.label === "string" && item.label.trim()
        ? [{ label: item.label, ...(typeof item.description === "string" ? { description: item.description } : {}) }]
        : [];
    });
    if (options.length === 0) return null;
    questions.push({
      question: value.question,
      ...(typeof value.header === "string" ? { header: value.header } : {}),
      multiSelect: value.multiSelect === true,
      options,
    });
  }
  return questions;
}

/**
 * The gate's options. Plan approvals and tool approvals differ in wording and
 * in whether "always allow" is meaningful — a plan is approved once, there is
 * no "this tool kind" to remember.
 */
export function optionsFor(approval: PendingApproval): GateOption[] {
  const isPlan = approval.toolName === "ExitPlanMode";
  const isInteractive = approval.requiresUserInteraction || approval.toolName === "AskUserQuestion";
  const options: GateOption[] = [
    {
      key: "A",
      label: isPlan ? "Proceed in build" : "Approve once",
      decision: "accept",
      variant: "primary",
    },
  ];
  if (!isPlan && !isInteractive) {
    options.push({
      key: "B",
      label: "Always allow this session",
      decision: "acceptForSession",
      variant: "secondary",
    });
  }
  options.push({
    key: isPlan ? "B" : "C",
    label: isPlan ? "Keep planning — tell it what to change" : "Decline — tell it what to do instead",
    decision: "decline",
    variant: "secondary",
    sendsGuidance: true,
  });
  options.push({
    key: isPlan ? "C" : "D",
    label: "Cancel turn",
    decision: "cancel",
    variant: "destructive",
  });
  return options;
}

export interface V2ApprovalGateProps {
  approval: PendingApproval;
  /** How many approvals are queued — the drawer's count badge. */
  count: number;
  /** Resolve the approval over the existing control-request path. */
  respond: (id: string, decision: PermissionDecision, updatedInput?: unknown) => void;
  /**
   * Hand the composer's typed text to the agent as the next turn. Called only
   * for a guidance-bearing decision, and only when the user actually typed
   * something. The `permission-response` frame carries no text field, so
   * guidance rides the following message rather than the denial itself.
   */
  sendGuidance?: (text: string) => void;
  /** Current composer text, so a guidance option knows whether to send. */
  guidance?: string;
}

export default function V2ApprovalGate({
  approval,
  count,
  respond,
  sendGuidance,
  guidance = "",
}: V2ApprovalGateProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const options = optionsFor(approval);
  const questions = useMemo(
    () => approval.toolName === "AskUserQuestion" ? parseAskUserQuestion(approval.input) : null,
    [approval.input, approval.toolName],
  );
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  // AC2: focus moves into the option list when the gate appears. Keyed on the
  // approval id so a SECOND queued approval re-focuses rather than leaving the
  // user's focus on a button that now decides a different request.
  useEffect(() => {
    const node = groupRef.current?.querySelector("input, button");
    if (node instanceof HTMLElement) node.focus();
  }, [approval.id]);

  useEffect(() => {
    setAnswers({});
    setOther({});
    setSubmitted(false);
  }, [approval.id]);

  if (approval.toolName === "AskUserQuestion" && !questions) {
    return (
      <ChatComposerDrawer data-slot="v2-approval-gate" label="Answer requested" count={count}>
        <VStack gap={3} ref={groupRef} data-slot="v2-question-gate-error">
          <VStack gap={1}>
            <Text type="body" weight="medium">This question could not be displayed</Text>
            <Text type="supporting" color="secondary">
              Cancel this turn, then ask the agent to present the question again.
            </Text>
          </VStack>
          <Button label="Cancel turn" variant="destructive" size="sm" onClick={() => respond(approval.id, "cancel")} />
        </VStack>
      </ChatComposerDrawer>
    );
  }

  if (questions) {
    const answerFor = (index: number) => [
      ...(answers[index] ?? []),
      ...(other[index]?.trim() ? [other[index].trim()] : []),
    ];
    const complete = questions.every((_, index) => answerFor(index).length > 0);
    const submit = () => {
      setSubmitted(true);
      if (!complete) return;
      const answerMap = Object.fromEntries(
        questions.map((question, index) => [question.question, answerFor(index).join(", ")]),
      );
      respond(approval.id, "accept", {
        ...(approval.input as Record<string, unknown>),
        answers: answerMap,
      });
    };
    return (
      <ChatComposerDrawer data-slot="v2-approval-gate" label="Answer requested" count={count}>
        <VStack gap={3} ref={groupRef} data-slot="v2-question-gate">
          <VStack gap={1}>
            <Text type="body" weight="medium">The agent needs your input</Text>
            <Text type="supporting" color="secondary">Answer each question to continue this turn.</Text>
          </VStack>
          {questions.map((question, index) => (
            <fieldset key={question.question} {...stylex.props(styles.question)}>
              <VStack gap={2}>
                <legend><Text type="body" weight="medium">{question.header || question.question}</Text></legend>
                {question.header ? <Text type="supporting" color="secondary">{question.question}</Text> : null}
                {question.options.map((option) => {
                  const selected = answers[index]?.includes(option.label) ?? false;
                  return (
                    <label key={option.label} {...stylex.props(styles.optionLabel)}>
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={`question-${approval.id}-${index}`}
                        checked={selected}
                        onChange={() => {
                          setAnswers((current) => ({
                            ...current,
                            [index]: question.multiSelect
                              ? selected ? (current[index] ?? []).filter((item) => item !== option.label) : [...(current[index] ?? []), option.label]
                              : [option.label],
                          }));
                          if (!question.multiSelect) setOther((current) => ({ ...current, [index]: "" }));
                        }}
                        {...stylex.props(styles.optionInput)}
                      />
                      <VStack gap={0}>
                        <Text type="body">{option.label}</Text>
                        {option.description ? <Text type="supporting" color="secondary">{option.description}</Text> : null}
                      </VStack>
                    </label>
                  );
                })}
                <label {...stylex.props(styles.optionLabel)}>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`question-${approval.id}-${index}`}
                    checked={Boolean(other[index])}
                    onChange={() => {
                      setOther((current) => ({ ...current, [index]: current[index] || " " }));
                      if (!question.multiSelect) setAnswers((current) => ({ ...current, [index]: [] }));
                    }}
                    {...stylex.props(styles.optionInput)}
                  />
                  <VStack gap={1}>
                    <Text type="body">Other</Text>
                    <input
                      aria-label={`Other answer for ${question.header || question.question}`}
                      value={other[index] ?? ""}
                      onChange={(event) => setOther((current) => ({ ...current, [index]: event.target.value }))}
                      {...stylex.props(styles.otherInput)}
                    />
                  </VStack>
                </label>
              </VStack>
            </fieldset>
          ))}
          {submitted && !complete ? <Text type="supporting" xstyle={styles.error}>Answer each question before continuing.</Text> : null}
          <HStack gap={2}>
            <Button label="Submit answers" variant="primary" size="sm" onClick={submit} />
            <Button label="Cancel turn" variant="destructive" size="sm" onClick={() => respond(approval.id, "cancel")} />
          </HStack>
        </VStack>
      </ChatComposerDrawer>
    );
  }

  const decide = (option: GateOption) => {
      // Order matters: resolve the block first so the agent is unblocked, then
      // send the guidance as the next turn. Sending first would queue a message
      // behind a driver that is still waiting on us.
      respond(approval.id, option.decision);
      const text = guidance.trim();
      if (option.sendsGuidance && text && sendGuidance) sendGuidance(text);
  };

  // Letter shortcuts, scoped to the gate so they never eat the composer's input.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const pressed = event.key.toUpperCase();
      const match = options.find((option) => option.key === pressed);
      if (match) {
        event.preventDefault();
        decide(match);
        return;
      }
      // Roving with the arrows; the buttons themselves handle Enter and Space.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const buttons = Array.from(
          groupRef.current?.querySelectorAll("button") ?? [],
        ).filter((node): node is HTMLButtonElement => node instanceof HTMLButtonElement);
        if (buttons.length === 0) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "ArrowDown"
            ? buttons[(index + 1 + buttons.length) % buttons.length]
            : buttons[(index - 1 + buttons.length) % buttons.length];
        event.preventDefault();
        next?.focus();
      }
      // Escape is deliberately NOT handled. The agent is blocked waiting on this
      // answer; a gate that can be dismissed would leave the turn stalled with
      // nothing on screen explaining why.
  };

  const isPlan = approval.toolName === "ExitPlanMode";
  const showsGuidanceHint = guidance.trim().length > 0;

  return (
    <ChatComposerDrawer
      data-slot="v2-approval-gate"
      label="User feedback requested"
      count={count}
    >
      <VStack gap={2} data-slot="v2-approval-gate-body">
        <V2ApprovalContent approval={approval} count={count} />
        <VStack
          ref={groupRef}
          gap={2}
          role="group"
          aria-label={isPlan ? "Plan approval options" : "Permission options"}
          onKeyDown={onKeyDown}
          data-slot="v2-approval-options"
          xstyle={styles.options}
        >
          <VStack gap={2}>
            {options.map((option) => (
              <HStack key={option.decision} gap={2} align="center" xstyle={styles.option}>
                <Badge label={option.key} variant="neutral" xstyle={styles.badge} />
                <Button
                  ref={option.decision === options[0]?.decision ? firstOptionRef : undefined}
                  label={option.label}
                  variant={option.variant}
                  size="sm"
                  onClick={() => decide(option)}
                />
              </HStack>
            ))}
          </VStack>
          {showsGuidanceHint ? (
            <VStack gap={0} xstyle={styles.guidanceHint}>
              <Text type="supporting" color="secondary">
                Your typed message will be sent with a decline.
              </Text>
            </VStack>
          ) : null}
        </VStack>
      </VStack>
    </ChatComposerDrawer>
  );
}
