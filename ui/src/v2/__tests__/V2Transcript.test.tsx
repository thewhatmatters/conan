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
    render(<V2Transcript items={[tool]} />);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/file contents/)).toBeInTheDocument();
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

  it("shows Working… while busy with no assistant text yet", () => {
    render(<V2Transcript items={[user]} busy />);

    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("hides Working… once assistant text is present", () => {
    render(<V2Transcript items={[user, assistant]} busy />);

    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });
});
