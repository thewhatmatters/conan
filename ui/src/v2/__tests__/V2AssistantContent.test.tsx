import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import V2AssistantContent, {
  parseAssistantContent,
} from "../chat/V2AssistantContent.tsx";

describe("V2AssistantContent", () => {
  it("renders labeled JSON through Astryx CodeBlock with a language label", () => {
    const { container } = render(
      <V2AssistantContent text={'Result:\n\n```json\n{"ok":true}\n```'} />,
    );

    expect(screen.getByText("Result:")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="assistant-code-block"]')).not.toBeNull();
    expect(screen.getByText("json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy code/i })).toBeInTheDocument();
  });

  it("copies the exact original fence body without pretty-printing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const original = '{  "nested": [1,  2] }\n';
    render(<V2AssistantContent text={`\`\`\`json\n${original}\`\`\``} />);

    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith(original);
  });

  it("infers JSON for valid unlabeled objects and arrays only", () => {
    const object = parseAssistantContent('```\n{"ok": true}\n```');
    const array = parseAssistantContent("```\n[1, 2]\n```");
    const invalid = parseAssistantContent("```\n{still streaming\n```");

    expect(object[0]).toMatchObject({ kind: "code", language: "json" });
    expect(array[0]).toMatchObject({ kind: "code", language: "json" });
    expect(invalid[0]).toMatchObject({ kind: "code", language: "plaintext" });
  });

  it("keeps long lines inside a keyboard-scrollable code region", () => {
    render(<V2AssistantContent text={`\`\`\`json\n{"value":"${"x".repeat(300)}"}\n\`\`\``} />);

    const region = screen.getByRole("group", { name: "json" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.textContent).toContain("x".repeat(300));
  });

  it("gives tall blocks Astryx's keyboard-operable collapse control", () => {
    const code = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    render(<V2AssistantContent text={`\`\`\`text\n${code}\n\`\`\``} />);

    const disclosure = screen.getByRole("button", { name: /text/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });

  it("shares one parser across prose and multiple fenced languages", () => {
    const parts = parseAssistantContent(
      "Before\n```json\n{}\n```\nBetween\n```ts\nconst x = 1;\n```\nAfter",
    );

    expect(parts.map((part) => part.kind)).toEqual([
      "prose",
      "code",
      "prose",
      "code",
      "prose",
    ]);
    expect(parts.filter((part) => part.kind === "code").map((part) => part.language))
      .toEqual(["json", "ts"]);
  });

  it("keeps an incomplete labeled stream on the same CodeBlock path", () => {
    const { container, rerender } = render(
      <V2AssistantContent text={'```json\n{"items":'} />,
    );
    const first = container.querySelector('[data-slot="assistant-code-block"]');
    expect(first).not.toBeNull();
    expect(screen.getByText("json")).toBeInTheDocument();

    rerender(<V2AssistantContent text={'```json\n{"items":[1,2]}\n```'} />);
    const completed = container.querySelector('[data-slot="assistant-code-block"]');
    expect(completed).toBe(first);
    expect(screen.getByText("json")).toBeInTheDocument();
    expect(container.textContent).not.toContain("```json");
  });
});
