/**
 * V2Transcript — text-only streaming rows (US-202).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("button", { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith(code);
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
