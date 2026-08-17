import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import V2AssistantContent, {
  parseAssistantContent,
} from "../chat/V2AssistantContent.tsx";

describe("V2AssistantContent", () => {
  it("renders assistant prose through Astryx Markdown", () => {
    const { container } = render(
      <V2AssistantContent
        text={"# Release notes\n\nThis is **ready** with `inline code`.\n\n- First\n- Second\n\nhttps://example.com"}
      />,
    );

    expect(screen.getByRole("heading", { name: "Release notes", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("ready").tagName).toBe("STRONG");
    expect(container.querySelector("code")).toHaveTextContent("inline code");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });

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

  it("parameterises the data-slot so callers do not claim assistant content", () => {
    const { container } = render(<V2AssistantContent text="Hi" slot="user-message-content" />);

    expect(container.querySelector('[data-slot="user-message-content"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="assistant-message-content"]')).toBeNull();
  });

  it("renders GFM tables", () => {
    const text = "| A | B |\n|---|---|\n| 1 | 2 |";
    render(<V2AssistantContent text={text} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("A");
    expect(table.textContent).toContain("B");
    expect(table.textContent).toContain("1");
    expect(table.textContent).toContain("2");
  });

  it("renders GFM task lists", () => {
    const text = "- [x] done\n- [ ] todo";
    const { container } = render(<V2AssistantContent text={text} />);

    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("renders nested lists", () => {
    const text = "- outer\n  - inner\n    - deeper";
    render(<V2AssistantContent text={text} />);

    const lists = screen.getAllByRole("list");
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("renders blockquotes", () => {
    const text = "> quoted";
    const { container } = render(<V2AssistantContent text={text} />);

    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
  });

  it("autolinks plain URLs with GFM", () => {
    render(<V2AssistantContent text="See https://example.com/page" />);

    const link = screen.getByRole("link", { name: "https://example.com/page" });
    expect(link).toHaveAttribute("href", "https://example.com/page");
  });
});
