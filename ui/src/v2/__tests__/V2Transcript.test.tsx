/**
 * V2Transcript — text-only streaming rows (US-202).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import V2Transcript from "../chat/V2Transcript.tsx";
import type { ChatItem } from "../lib/useV2Chat.ts";

const user: ChatItem = {
  id: "u1",
  role: "user",
  text: "Hello agent",
  ts: Date.UTC(2026, 6, 31, 18, 0),
};
const assistant: ChatItem = {
  id: "a1",
  role: "assistant",
  text: "Hello human",
  ts: Date.UTC(2026, 6, 31, 18, 1),
};
const tool: ChatItem = {
  id: "t1",
  role: "tool",
  name: "Read",
  input: { path: "src/App.tsx" },
  result: "file contents",
  isError: false,
};

describe("V2Transcript", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a filled user bubble and unbubbled assistant copy with timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 15, 0));
    const { container } = render(
      <V2Transcript items={[user, assistant]} />,
    );

    expect(container.querySelector('[data-slot="v2-transcript"]')).not.toBeNull();
    expect(screen.getByText("Hello agent")).toBeInTheDocument();
    expect(screen.getByText("Hello human")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-variant="filled"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="assistant-message-bubble"]')).toBeNull();
    expect(container.querySelector('[data-slot="assistant-message-content"]')).not.toBeNull();
    expect(container.querySelectorAll("time")).toHaveLength(2);
    expect(container.querySelectorAll('[data-format="time"]')).toHaveLength(2);
  });

  it("includes the date for messages older than today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 15, 0));
    const yesterday: ChatItem = {
      ...assistant,
      id: "a-yesterday",
      ts: new Date(2026, 6, 30, 16, 22).getTime(),
    };
    const { container } = render(<V2Transcript items={[yesterday]} />);

    expect(container.querySelector('[data-format="date_time"]')).not.toBeNull();
  });

  it("adds quiet Astryx date landmarks at local day boundaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 31, 15, 0));
    const yesterday: ChatItem = {
      ...assistant,
      id: "a-yesterday",
      ts: new Date(2026, 6, 30, 16, 22).getTime(),
    };
    const earlier: ChatItem = {
      ...user,
      id: "u-earlier",
      text: "Earlier this week",
      ts: new Date(2026, 6, 28, 9, 0).getTime(),
    };

    render(<V2Transcript items={[earlier, yesterday, user, assistant]} />);

    const dividers = screen.getAllByRole("separator");
    expect(dividers[0]).toHaveAccessibleName("Jul 28");
    expect(dividers[1]).toHaveAccessibleName("Yesterday");
    expect(dividers[2]).toHaveAccessibleName("Today");
    expect(screen.getAllByText("Today")).toHaveLength(1);
  });

  it("includes the year on absolute divider labels outside the current year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 12, 0));
    const lastYear: ChatItem = {
      ...assistant,
      id: "a-last-year",
      ts: new Date(2025, 11, 31, 16, 22).getTime(),
    };

    render(<V2Transcript items={[lastYear]} />);

    expect(screen.getByRole("separator")).toHaveAccessibleName(/Dec 31.*2025/);
  });

  it("splits a tool rollup when live activity crosses local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 0, 5));
    const beforeMidnight: ChatItem = {
      ...tool,
      id: "t-before",
      name: "Read",
      ts: new Date(2026, 6, 31, 23, 59).getTime(),
    };
    const afterMidnight: ChatItem = {
      ...tool,
      id: "t-after",
      name: "Bash",
      input: { command: "date" },
      ts: new Date(2026, 7, 1, 0, 1).getTime(),
    };

    render(<V2Transcript items={[beforeMidnight, afterMidnight]} busy />);

    const dividers = screen.getAllByRole("separator");
    expect(dividers[0]).toHaveAccessibleName("Yesterday");
    expect(dividers[1]).toHaveAccessibleName("Today");
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("groups adjacent tool activity into an expandable Astryx rollup", () => {
    const secondTool: ChatItem = {
      ...tool,
      id: "t2",
      name: "Bash",
      input: { command: "npm test" },
    };
    render(<V2Transcript items={[user, tool, secondTool]} />);

    expect(screen.getAllByText("Bash").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0);
    const rollup = screen.getByRole("button", { name: /Bash npm test 2/i });
    expect(rollup).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(rollup);
    expect(rollup).toHaveAttribute("aria-expanded", "true");
  });

  it("exposes completed tool output as expandable detail", () => {
    const { container } = render(<V2Transcript items={[tool]} />);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/file contents/)).toBeInTheDocument();
    expect(container.querySelector('[data-slot="assistant-code-block"]')).toBeNull();
  });

  it("renders fenced tool output through the shared Astryx CodeBlock path", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const code = '{  "status": "ok", "items": [1,  2] }\n';
    const jsonTool: ChatItem = {
      ...tool,
      id: "t-json",
      name: "Bash",
      input: { command: "read-json" },
      result: `Payload follows:\n\n\`\`\`json\n${code}\`\`\``,
    };
    const { container } = render(<V2Transcript items={[jsonTool]} />);

    fireEvent.click(screen.getByRole("button", { name: /Bash read-json/i }));
    expect(
      container.querySelector('[data-slot="assistant-message-content"]'),
    ).toHaveTextContent("Payload follows:");
    expect(container.querySelector('[data-slot="assistant-code-block"]')).not.toBeNull();
    expect(screen.getByRole("group", { name: "json" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("```json");

    const jsonBlock = screen.getByRole("group", { name: "json" }).closest("pre");
    expect(jsonBlock).not.toBeNull();
    fireEvent.click(
      within(jsonBlock!).getByRole("button", {
        name: /copy code/i,
      }),
    );
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it("renders a completed Bash input as a rich shell card and keeps prose results", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const command = "printf '  alpha  \\n'\necho done\n";
    const bashTool: ChatItem = {
      ...tool,
      id: "t-bash",
      name: "Bash",
      input: { command },
      result: "Command completed successfully.",
    };
    const { container } = render(<V2Transcript items={[bashTool]} />);

    fireEvent.click(screen.getByRole("button", { name: /Bash printf/i }));
    const bash = screen.getByRole("group", { name: "bash" });
    expect(bash).toBeInTheDocument();
    expect(container.querySelector('[data-slot="v2-bash-tool-detail"]')).not.toBeNull();
    expect(screen.getByText("Command completed successfully.")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="assistant-code-block"]')).toHaveLength(0);

    const bashBlock = bash.closest("pre");
    expect(bashBlock).not.toBeNull();
    fireEvent.click(within(bashBlock!).getByRole("button", { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith(command);
  });

  it("keeps long commands out of the scan row and preserves them in detail", () => {
    const command = `npm test -- ${"very-long-argument ".repeat(12)}`.trim();
    const longTool: ChatItem = {
      ...tool,
      input: { command },
      result: null,
    };
    const { container } = render(<V2Transcript items={[longTool]} />);

    const target = container.querySelector(".astryx-chat-tool-calls [class*='callLabel']")
      ?? screen.getByText((text) => text.endsWith("…"));
    expect(target.textContent?.length).toBeLessThanOrEqual(96);
    expect(screen.queryByText(command)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText((text) => text.includes(command))).toBeInTheDocument();
  });

  // WHA-90 replaced the "Working…" string with the thinking orb. The BEHAVIOUR
  // these two guard is unchanged and is the streaming handoff itself: the
  // indicator occupies the next assistant slot until the first token lands,
  // then the real message takes that slot with no jump. Asserting the slot
  // rather than the copy keeps the guard while letting the copy escalate.
  it("shows the thinking orb while busy with no assistant text yet", () => {
    const { container } = render(<V2Transcript items={[user]} busy />);

    expect(container.querySelector('[data-slot="v2-working"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="v2-thinking-orb"]')).not.toBeNull();
  });

  it("hides the thinking orb once assistant text is present", () => {
    const { container } = render(<V2Transcript items={[user, assistant]} busy />);

    expect(container.querySelector('[data-slot="v2-working"]')).toBeNull();
    expect(container.querySelector('[data-slot="v2-thinking-orb"]')).toBeNull();
  });

  it("streams only the current turn's live assistant tail while busy", () => {
    const secondUser: ChatItem = { ...user, id: "u2", text: "Next turn" };
    const liveAssistant: ChatItem = {
      ...assistant,
      id: "a2",
      text: "Live reply",
    };
    const { container } = render(
      <V2Transcript
        items={[user, assistant, secondUser, liveAssistant]}
        busy
      />,
    );

    const assistantRows = container.querySelectorAll(
      '[data-slot="assistant-message-content"]',
    );
    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]).toHaveAttribute("data-is-streaming", "false");
    expect(assistantRows[1]).toHaveAttribute("data-is-streaming", "true");
  });

  it("settles the live assistant tail when busy becomes false", () => {
    const { container, rerender } = render(
      <V2Transcript items={[user, assistant]} busy />,
    );
    const content = container.querySelector(
      '[data-slot="assistant-message-content"]',
    );
    expect(content).toHaveAttribute("data-is-streaming", "true");

    rerender(<V2Transcript items={[user, assistant]} busy={false} />);
    expect(content).toHaveAttribute("data-is-streaming", "false");
    expect(screen.getByText("Hello human")).toBeInTheDocument();
  });

  it("never marks tool result detail as streaming", () => {
    const { container } = render(<V2Transcript items={[user, tool]} busy />);

    fireEvent.click(screen.getByRole("button"));
    expect(
      container.querySelector('[data-slot="assistant-message-content"]'),
    ).toHaveAttribute("data-is-streaming", "false");
  });

  it("does not treat assistant-only loaded history as a live turn", () => {
    const { container } = render(<V2Transcript items={[assistant]} busy />);

    expect(
      container.querySelector('[data-slot="assistant-message-content"]'),
    ).toHaveAttribute("data-is-streaming", "false");
  });

  /**
   * The orb sits on the assistant TEXT axis, not the user-bubble axis.
   *
   * Randy reported the orb reading 16px right of the reply that replaces it,
   * twice. Cause: the orb was wrapped in `<ChatMessageBubble variant="ghost">`,
   * and Astryx documents ghost as "no background, but keeps padding for
   * consistent alignment" — `paddingInline: --spacing-4`, 16px at the default
   * balanced density. That padding aligns a ghost bubble with a FILLED one;
   * assistant prose here is unbubbled, so the two never shared an edge.
   *
   * jsdom lays nothing out, so this asserts the STRUCTURE that produced the
   * offset — no bubble in the working slot — rather than a measured px. The
   * user-bubble assertion is what keeps it honest: it proves the bubble
   * selector still matches something, so a renamed class turns this into a
   * failure instead of a test that passes because it found nothing.
   */
  it("renders the orb unbubbled, on the same axis as assistant text", () => {
    const { container } = render(<V2Transcript items={[user]} busy />);

    const working = container.querySelector('[data-slot="v2-working"]');
    expect(working).not.toBeNull();
    expect(working!.querySelector(".astryx-chat-message-bubble")).toBeNull();
    // Not vacuous: the user's message IS bubbled, by the same selector.
    expect(container.querySelector(".astryx-chat-message-bubble")).not.toBeNull();
  });

  it("renders the reasoning row unbubbled too — same 16px offset", () => {
    const reasoningItem: ChatItem = {
      id: "r-align",
      role: "reasoning",
      text: "considering",
      ts: 1,
    };
    render(<V2Transcript items={[user, reasoningItem]} busy />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(
      screen.getByText("Thinking…").closest(".astryx-chat-message-bubble"),
    ).toBeNull();
  });

  it("removes a completed turn's stale reasoning row", () => {
    const reasoning: ChatItem = {
      id: "r1",
      role: "reasoning",
      text: "private reasoning text",
      ts: Date.UTC(2026, 6, 31, 18, 0, 30),
    };
    render(<V2Transcript items={[user, reasoning, assistant]} />);

    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(screen.getByText("Hello human")).toBeInTheDocument();
  });

  it("does not let a later turn hide an earlier in-flight reasoning row", () => {
    const reasoning: ChatItem = {
      id: "r2",
      role: "reasoning",
      text: "current reasoning",
    };
    render(
      <V2Transcript items={[user, reasoning, { ...user, id: "u2", text: "Next turn" }]} />,
    );

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });
});

describe("V2Transcript thinking state across turns (WHA-90)", () => {
  // REGRESSION. `hasAssistantText` scanned the WHOLE item list, so once a
  // thread contained any assistant reply the indicator could never show again:
  // the thinking state appeared on a thread's FIRST turn and never afterwards.
  // The old "Working…" line was quiet enough that nobody caught it.
  it("shows the orb on a SECOND turn, not just the first", () => {
    const { container } = render(
      <V2Transcript items={[user, assistant, { ...user, id: "u2" }]} busy />,
    );

    expect(container.querySelector('[data-slot="v2-thinking-orb"]')).not.toBeNull();
  });

  it("still hides it once THIS turn has produced text", () => {
    const { container } = render(
      <V2Transcript
        items={[user, assistant, { ...user, id: "u2" }, { ...assistant, id: "a2" }]}
        busy
      />,
    );

    expect(container.querySelector('[data-slot="v2-thinking-orb"]')).toBeNull();
  });
});

describe("V2Transcript user markdown (WHA-52)", () => {
  it("renders user prose through markdown with the user content slot", () => {
    const markdownUser: ChatItem = {
      id: "u-md",
      role: "user",
      text: "# Title\n\nThis is **bold** with `inline code`.\n\n- one\n- two\n\nhttps://example.com",
      ts: Date.UTC(2026, 6, 31, 18, 0),
    };
    const { container } = render(<V2Transcript items={[markdownUser]} />);

    expect(container.querySelector('[data-slot="user-message-content"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Title", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });

  it("renders GFM tables in a user bubble", () => {
    const tableUser: ChatItem = {
      id: "u-table",
      role: "user",
      text: "| A | B |\n|---|---|\n| 1 | 2 |",
      ts: 1,
    };
    render(<V2Transcript items={[tableUser]} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("A");
    expect(table.textContent).toContain("B");
    expect(table.textContent).toContain("1");
    expect(table.textContent).toContain("2");
  });

  it("renders GFM task lists in a user bubble", () => {
    const taskUser: ChatItem = {
      id: "u-tasks",
      role: "user",
      text: "- [x] done\n- [ ] todo",
      ts: 1,
    };
    const { container } = render(<V2Transcript items={[taskUser]} />);

    expect(screen.getByRole("list")).toBeInTheDocument();
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("renders nested lists and blockquotes in a user bubble", () => {
    const nestedUser: ChatItem = {
      id: "u-nested",
      role: "user",
      text: "> quote\n\n- outer\n  - inner",
      ts: 1,
    };
    const { container } = render(<V2Transcript items={[nestedUser]} />);

    expect(container.querySelector("blockquote")).toHaveTextContent("quote");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("does not turn a bare #tag into a heading", () => {
    const tagUser: ChatItem = {
      id: "u-tag",
      role: "user",
      text: "Use #hashtag in your answer",
      ts: 1,
    };
    const { container } = render(<V2Transcript items={[tagUser]} />);

    expect(container.querySelector("h2")).toBeNull();
    expect(screen.getByText("Use #hashtag in your answer")).toBeInTheDocument();
  });

  it("does not swallow a line that starts with a single asterisk", () => {
    const starUser: ChatItem = {
      id: "u-star",
      role: "user",
      text: "* important note",
      ts: 1,
    };
    const { container } = render(<V2Transcript items={[starUser]} />);

    // Markdown treats `* ` as a list marker; the text itself must still show.
    expect(container.querySelector("ul")).not.toBeNull();
    expect(screen.getByText("important note")).toBeInTheDocument();
  });

  it("keeps a large pasted file inside the bubble without exploding the layout", () => {
    const body = "export const x = 1;\n".repeat(200);
    const fileUser: ChatItem = {
      id: "u-file",
      role: "user",
      text: body,
      ts: 1,
    };
    const { container } = render(<V2Transcript items={[fileUser]} />);

    const content = container.querySelector('[data-slot="user-message-content"]');
    expect(content).not.toBeNull();
    expect(content!.textContent).toContain("export const x = 1;");
    expect(content!.textContent!.length).toBeGreaterThan(2000);
  });
});
