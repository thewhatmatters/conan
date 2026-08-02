import * as stylex from "@stylexjs/stylex";
import { ChatTokenizedText } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";

type ContentPart =
  | { kind: "prose"; key: string; text: string }
  | {
      kind: "code";
      key: string;
      code: string;
      language: string;
    };

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?/gm;

function closingFence(opening: string): RegExp {
  const marker = opening[0] === "~" ? "~" : "`";
  return new RegExp(`^ {0,3}${marker}{${opening.length},}[ \\t]*$`, "gm");
}

function declaredLanguage(info: string): string | null {
  const value = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return value || null;
}

function inferredLanguage(code: string): string {
  const candidate = code.trim();
  if (candidate.startsWith("{") || candidate.startsWith("[")) {
    try {
      JSON.parse(candidate);
      return "json";
    } catch {
      // An unlabeled partial/invalid payload stays plaintext inside the same
      // CodeBlock. Once a streamed value becomes valid, only tokenization
      // changes; the message never flashes back to a prose renderer.
    }
  }
  return "plaintext";
}

export function parseAssistantContent(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  let cursor = 0;

  OPENING_FENCE.lastIndex = 0;
  for (let opening = OPENING_FENCE.exec(text); opening; opening = OPENING_FENCE.exec(text)) {
    const fence = opening[1];
    if (!fence) continue;
    if (opening.index > cursor) {
      parts.push({
        kind: "prose",
        key: `prose-${cursor}`,
        text: text.slice(cursor, opening.index),
      });
    }

    const bodyStart = OPENING_FENCE.lastIndex;
    const closePattern = closingFence(fence);
    closePattern.lastIndex = bodyStart;
    const close = closePattern.exec(text);
    const bodyEnd = close?.index ?? text.length;
    const code = text.slice(bodyStart, bodyEnd);
    parts.push({
      kind: "code",
      key: `code-${opening.index}`,
      code,
      language: declaredLanguage(opening[2] ?? "") ?? inferredLanguage(code),
    });

    if (!close) {
      cursor = text.length;
      break;
    }

    cursor = close.index + close[0].length;
    OPENING_FENCE.lastIndex = cursor;
  }

  if (cursor < text.length) {
    parts.push({ kind: "prose", key: `prose-${cursor}`, text: text.slice(cursor) });
  }

  return parts;
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--conan-space-3)",
    maxWidth: "100%",
    minWidth: 0,
    overflowWrap: "anywhere",
    width: "100%",
  },
  prose: {
    display: "block",
    maxWidth: "100%",
    minWidth: 0,
    overflowWrap: "anywhere",
    width: "100%",
  },
  code: {
    maxWidth: "100%",
    minWidth: 0,
    width: "100%",
  },
});

export default function V2AssistantContent({ text }: { text: string }) {
  return (
    <div data-slot="assistant-message-content" {...stylex.props(styles.root)}>
      {parseAssistantContent(text).map((part) =>
        part.kind === "prose" ? (
          part.text ? (
            <ChatTokenizedText key={part.key} xstyle={styles.prose}>
              {part.text}
            </ChatTokenizedText>
          ) : null
        ) : (
          <CodeBlock
            key={part.key}
            data-slot="assistant-code-block"
            code={part.code}
            language={part.language}
            hasCopyButton
            hasLanguageLabel
            isCollapsible
            collapsibleThreshold={12}
            isWrapped={false}
            width="100%"
            xstyle={styles.code}
          />
        ),
      )}
    </div>
  );
}
