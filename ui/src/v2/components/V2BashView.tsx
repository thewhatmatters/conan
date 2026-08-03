import * as stylex from "@stylexjs/stylex";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";

const styles = stylex.create({
  root: {
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
  code: {
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
});

/** The Bash tool contract is an object with one byte-significant command. */
export function bashCommand(input: unknown): string | null {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

/** Shared shell-script card for pending and completed Bash tool calls. */
export default function V2BashView({ command }: { command: string }) {
  return (
    <div data-slot="v2-bash-view" {...stylex.props(styles.root)}>
      <CodeBlock
        data-slot="v2-bash-code-block"
        code={command}
        language="bash"
        hasCopyButton
        hasLanguageLabel
        isCollapsible
        collapsibleThreshold={12}
        isWrapped={false}
        width="100%"
        xstyle={styles.code}
      />
    </div>
  );
}
